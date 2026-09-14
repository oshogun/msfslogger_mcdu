use crate::{config::{lock, ConfigStore}, framing::{self, Line}, protocol::{self, DecodeError}, restart::{RestartBudget, RESTART_DELAY, SHUTDOWN_GRACE}};
use serde_json::{json, Value};
use std::{collections::VecDeque, io::{BufReader, Read, Write}, path::{Path, PathBuf}, process::{Child, Command, ExitStatus, Stdio}, sync::{atomic::{AtomicBool, Ordering}, mpsc::{self, Receiver, SyncSender}, Arc, Mutex}, thread::{self, JoinHandle}, time::{Duration, Instant}};

pub enum Event { Status(Value), Log(Value), Exit(Value) }
pub type EventSink = Arc<dyn Fn(Event) + Send + Sync>;

#[derive(Clone, Copy)]
pub enum Operation { Start, Stop, Restart, Reload }

#[derive(Default)]
pub struct Snapshot {
    pub status: Option<Value>,
    pub hello: Option<Value>,
    pub pong: Option<Value>,
    logs: VecDeque<Value>,
}

pub struct Supervisor {
    pub config: Arc<ConfigStore>,
    pub snapshot: Arc<Mutex<Snapshot>>,
    requests: SyncSender<Operation>,
    stopping: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Supervisor {
    pub fn new(config: ConfigStore, resource_entry: Option<PathBuf>, sink: EventSink) -> Result<Self, String> {
        let config = Arc::new(config);
        // The only thing the shell reads out of the file is autoUplink, which
        // is its own decision to act on. Whether the config is usable at all
        // is the sidecar's judgement, reported by the sidecar, so there is no
        // second set of validation rules here to drift out of step.
        let auto_uplink = config.read().ok().flatten()
            .and_then(|raw| raw.get("autoUplink").and_then(Value::as_bool)).unwrap_or(false);
        let snapshot = Arc::new(Mutex::new(Snapshot {
            status: Some(protocol::idle_status("app.starting")), ..Snapshot::default()
        }));
        let stopping = Arc::new(AtomicBool::new(false));
        let (requests, receiver) = mpsc::sync_channel(64);
        let (lines, stream) = mpsc::sync_channel(128);
        let mut worker = Worker {
            config: config.clone(), snapshot: snapshot.clone(), stopping: stopping.clone(), sink,
            resource_entry, child: None, input: None, generation: 0, lines, stream,
            budget: RestartBudget::default(), restart_at: None, desired_running: auto_uplink,
            version_error_logged: false, crash_latched: false,
        };
        let thread = thread::Builder::new().name("sidecar-supervisor".into()).spawn(move || {
            // The sidecar always runs, so it can report on its own config and
            // on the sim. Manual START stays the baseline for the uplink: an
            // absent or non-boolean autoUplink reads false, and then nothing
            // is posted to the server until the user presses START.
            worker.spawn();
            worker.run(receiver);
        }).map_err(|_| "Cannot start sidecar supervisor")?;
        Ok(Self { config, snapshot, requests, stopping, worker: Mutex::new(Some(thread)) })
    }

    pub fn request(&self, operation: Operation) -> Result<(), String> {
        if self.stopping.load(Ordering::Acquire) { return Err("App is shutting down".into()); }
        self.requests.try_send(operation).map_err(|_| "Sidecar supervisor is busy or unavailable".into())
    }

    pub fn shutdown(&self) {
        // A separate flag gives close/exit priority over queued button presses.
        self.stopping.store(true, Ordering::Release);
        if let Some(worker) = lock(&self.worker).take() { let _ = worker.join(); }
    }
}

impl Drop for Supervisor { fn drop(&mut self) { self.shutdown(); } }

struct StreamLine { generation: u64, stderr: bool, line: Line }

struct Worker {
    config: Arc<ConfigStore>, snapshot: Arc<Mutex<Snapshot>>, stopping: Arc<AtomicBool>, sink: EventSink,
    resource_entry: Option<PathBuf>, child: Option<Child>, input: Option<SyncSender<&'static str>>, generation: u64,
    lines: SyncSender<StreamLine>, stream: Receiver<StreamLine>,
    budget: RestartBudget, restart_at: Option<Instant>, desired_running: bool, version_error_logged: bool, crash_latched: bool,
}

/// Strips Windows' `\\?\` extended-length/verbatim prefix, if present,
/// leaving the ordinary drive-letter form (`C:\...`). Leaves `\\?\UNC\...`
/// network paths and `\\?\Volume{GUID}\...` volume paths alone — both need a
/// different reconstruction than a plain prefix strip (`\\?\UNC\` expands to
/// `\\`; a volume GUID has no drive-letter form at all), which this narrow
/// fix doesn't need to handle. A no-op on any path that never had the
/// prefix, which is every path on non-Windows.
fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    match path.to_str() {
        Some(s) if s.starts_with(r"\\?\") && !s[4..].starts_with("UNC\\") && !s[4..].starts_with("Volume") => PathBuf::from(&s[4..]),
        _ => path.to_path_buf(),
    }
}

impl Worker {
    fn run(&mut self, requests: Receiver<Operation>) {
        while !self.stopping.load(Ordering::Acquire) {
            match requests.recv_timeout(Duration::from_millis(20)) {
                Ok(operation) => self.apply(operation),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            // Bound work per tick so flooding stdout cannot starve STOP/exit.
            for _ in 0..64 {
                let Ok(line) = self.stream.try_recv() else { break; };
                // A dead child may leave logs queued behind its exit. Keep
                // those diagnostics, but never let its late status undo the
                // synthetic crashed/restarting state or a newer child's state.
                let current = line.generation == self.generation;
                self.read_output(line, current);
            }
            if let Some(child) = self.child.as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => { self.child.take(); self.input.take(); self.generation += 1; self.unexpected_exit(status); }
                    Ok(None) => {},
                    Err(_) => {
                        self.log("error", "Cannot inspect sidecar process; stopping it");
                        self.terminate();
                        self.synthetic("app.crashed");
                    }
                }
            }
            if self.restart_at.is_some_and(|at| Instant::now() >= at) && !self.stopping.load(Ordering::Acquire) {
                self.restart_at = None;
                self.spawn();
            }
        }
        self.restart_at = None;
        self.terminate();
    }

    fn apply(&mut self, operation: Operation) {
        match operation {
            Operation::Start => {
                self.desired_running = true;
                if self.child.is_some() { self.control("start"); }
                // START cannot bypass an exhausted crash budget; RESTART is
                // the explicit action that clears it.
                else if self.crash_latched { self.log("warn", "Sidecar stopped after failure; use RESTART"); }
                else if self.restart_at.is_none() { self.spawn(); }
            }
            Operation::Stop => {
                self.desired_running = false;
                self.restart_at = None;
                // A live sidecar reports its own state after a stop. A dead
                // one is a fault, and saying "stopped" for it would claim a
                // working config nobody has checked.
                if self.child.is_some() { self.control("stop"); } else { self.synthetic("app.crashed"); }
            }
            Operation::Restart => {
                self.restart_at = None;
                self.budget.reset();
                self.crash_latched = false;
                self.terminate();
                self.synthetic("app.restarting");
                self.spawn();
            }
            Operation::Reload => {
                // The sidecar re-reads and re-validates the file; saving
                // settings never implies an uplink start. A pending respawn
                // picks the new file up on its own, so leave it alone.
                if self.child.is_some() { self.control("config"); }
                else if self.restart_at.is_none() { self.synthetic("app.crashed"); }
            }
        }
    }

    fn spawn(&mut self) {
        if self.child.is_some() || self.stopping.load(Ordering::Acquire) { return; }
        // Built one component at a time, not `.join("../sidecar/dist/index.js")`:
        // that embeds a literal ".." next to a forward-slash string, which on
        // Windows produces a mixed-separator, unnormalized path. Node's own
        // module-resolution directory walk chokes on that — it can degenerate
        // down to the bare string "C:" (no trailing backslash), which Windows
        // treats specially and fs.lstat rejects with EISDIR. Per-component
        // .join() never embeds a raw separator character, so this can't happen.
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("CARGO_MANIFEST_DIR is always windows-client/src-tauri, which has a parent")
            .join("sidecar").join("dist").join("index.js");
        let entry = self.resource_entry.as_ref().filter(|path| path.is_file()).cloned()
            .or_else(|| development.is_file().then_some(development.clone()));
        let Some(entry) = entry else {
            self.crash_latched = true;
            self.log("error", &format!("Sidecar entry missing; tried {} and {}",
                self.resource_entry.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "<unavailable resource directory>/sidecar/dist/index.js".into()), development.display()));
            self.synthetic("app.crashed");
            return;
        };
        // Tauri's path resolver returns Windows' "\\?\"-prefixed verbatim form
        // (the same form std::fs::canonicalize produces). The OS handles it
        // fine for actually opening the file, but Node's own package.json
        // boundary-walk for the main module does plain string manipulation
        // that does not expect that prefix, and mishandles the drive root —
        // producing exactly the EISDIR-on-"C:" crash a real Windows run hit.
        // Strip it back to the normal drive-letter form before handing this
        // to node; irrelevant off Windows since the prefix never appears there.
        let entry = strip_verbatim_prefix(&entry);
        let raw = self.config.read().ok().flatten();
        let node = raw.as_ref().and_then(|raw| raw.get("nodePath")).and_then(Value::as_str)
            .filter(|path| !path.trim().is_empty()).unwrap_or("node");
        let Some(directory) = entry.parent().and_then(|dist| dist.parent()) else {
            self.log("error", "Sidecar entry has no parent directory"); self.synthetic("app.crashed"); return;
        };
        let mut command = Command::new(node);
        command.arg(&entry).arg("--config").arg(&self.config.path).current_dir(directory)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        // Inherit the environment unchanged. Credentials and CA configuration
        // travel only through the file, never through argv or injected env vars.
        #[cfg(windows)] {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        match command.spawn() {
            Ok(mut child) => {
                self.generation += 1;
                self.version_error_logged = false;
                let stdin = child.stdin.take();
                let stdout = child.stdout.take();
                let stderr = child.stderr.take();
                self.child = Some(child);
                let input = stdin.ok_or_else(|| std::io::Error::other("Missing child stdin"))
                    .and_then(|pipe| self.writer(pipe));
                if input.is_err() {
                    self.log("error", "Cannot start sidecar input writer"); self.terminate(); self.synthetic("app.crashed"); return;
                }
                let readers = stdout.map(|pipe| self.reader(pipe, false)).transpose()
                    .and_then(|_| stderr.map(|pipe| self.reader(pipe, true)).transpose());
                if readers.is_err() {
                    self.log("error", "Cannot start sidecar output reader"); self.terminate(); self.synthetic("app.crashed"); return;
                }
                self.log("info", "Sidecar process started");
                // A fresh sidecar is idle and reports so itself; it is only
                // told to start when autoUplink or the user asked for it.
                if self.desired_running { self.control("start"); }
            }
            Err(_) => {
                self.crash_latched = true;
                self.log("error", "Cannot launch sidecar; install Node 20 on PATH or set nodePath in config.json");
                self.synthetic("app.crashed");
            }
        }
    }

    fn reader(&self, pipe: impl Read + Send + 'static, stderr: bool) -> std::io::Result<()> {
        let sender = self.lines.clone();
        let generation = self.generation;
        thread::Builder::new().name(if stderr { "sidecar-stderr" } else { "sidecar-stdout" }.into()).spawn(move || {
            let mut reader = BufReader::new(pipe);
            loop {
                match framing::read_line(&mut reader) {
                    Ok(Some(line)) => if sender.send(StreamLine { generation, stderr, line }).is_err() { break; },
                    Ok(None) => break,
                    Err(_) => {
                        let _ = sender.send(StreamLine { generation, stderr: true, line: Line::Text("Sidecar output pipe read failed".into()) });
                        break;
                    }
                }
            }
        }).map(|_| ())
    }

    fn writer(&mut self, mut stdin: std::process::ChildStdin) -> std::io::Result<()> {
        let (sender, receiver) = mpsc::sync_channel::<&'static str>(8);
        thread::Builder::new().name("sidecar-stdin".into()).spawn(move || {
            for kind in receiver {
                if writeln!(stdin, "{}", json!({"v":1,"type":kind})).and_then(|_| stdin.flush()).is_err() { break; }
                if kind == "shutdown" { break; }
            }
            // Dropping this handle sends EOF, including when the supervisor
            // closes its queue. A stuck write cannot block the kill deadline.
        })?;
        self.input = Some(sender);
        Ok(())
    }

    fn control(&mut self, kind: &'static str) {
        if self.input.as_ref().is_some_and(|input| input.try_send(kind).is_err()) {
            self.log("warn", "Cannot queue sidecar control; input is busy or closed");
        }
    }

    fn read_output(&mut self, line: StreamLine, current: bool) {
        let text = match line.line {
            Line::Oversize => { self.log("warn", "Dropped sidecar line larger than 65536 bytes"); return; }
            Line::InvalidUtf8 => { self.log("warn", "Dropped sidecar line with invalid UTF-8"); return; }
            Line::Text(text) => text,
        };
        if text.trim().is_empty() { return; }
        if line.stderr { self.log("error", &text); return; }
        match protocol::decode(&text) {
            Ok(mut value) => {
                self.config.redact(&mut value);
                match value["type"].as_str() {
                    Some("status") if current => self.status(value),
                    Some("log") => self.log_value(value),
                    Some("hello") if current => lock(&self.snapshot).hello = Some(value),
                    Some("pong") if current => lock(&self.snapshot).pong = Some(value),
                    _ => {} // Reserved messages have no webview events yet.
                }
            }
            // Never include the rejected bytes or parser details: a malformed
            // line can contain a token even though the normal protocol cannot.
            Err(DecodeError::BadVersion) => {
                if !self.version_error_logged { self.log("error", "Sidecar protocol version mismatch; expected 1"); self.version_error_logged = true; }
            }
            Err(DecodeError::UnknownType) => {},
            Err(_) => self.log("warn", "Dropped malformed or non-JSON sidecar message"),
        }
    }

    fn status(&self, value: Value) {
        lock(&self.snapshot).status = Some(value.clone());
        (self.sink)(Event::Status(value));
    }

    fn synthetic(&self, state: &str) {
        let mut value = lock(&self.snapshot).status.clone().unwrap_or_else(|| protocol::idle_status(state));
        value["at"] = json!(protocol::now());
        value["app"] = json!({"state": state});
        value["sim"]["state"] = json!("sim.idle");
        value["sim"]["nextRetryAt"] = Value::Null;
        value["sim"]["retryDelayMs"] = Value::Null;
        value["backend"]["state"] = json!("net.idle");
        self.status(value);
    }

    fn log(&self, level: &str, text: &str) {
        let message = self.config.redact_text(text);
        // Also visible in the `cargo tauri dev` terminal itself, not just the
        // webview's one-line scratchpad — the scratchpad only ever shows the
        // latest message, so a fast crash loop's real cause is otherwise gone
        // by the time anyone looks at the window.
        eprintln!("[sidecar:{level}] {message}");
        self.log_value(json!({"v":1, "type":"log", "at":protocol::now(), "level":level, "message":message}));
    }

    fn log_value(&self, value: Value) {
        { let mut cache = lock(&self.snapshot);
          if cache.logs.len() == 200 { cache.logs.pop_front(); }
          cache.logs.push_back(value.clone()); }
        (self.sink)(Event::Log(value));
    }

    fn unexpected_exit(&mut self, status: ExitStatus) {
        let remaining = self.budget.reserve(Instant::now());
        #[cfg(unix)]
        let signal = { use std::os::unix::process::ExitStatusExt; status.signal().map(|signal| signal.to_string()) };
        #[cfg(not(unix))]
        let signal: Option<String> = None;
        eprintln!("[sidecar] exited: code={:?} signal={:?}", status.code(), signal);
        (self.sink)(Event::Exit(json!({"code":status.code(), "signal":signal, "restarting":remaining.is_some(), "restartsRemaining":remaining.unwrap_or(0)})));
        self.synthetic("app.crashed");
        if remaining.is_some() {
            self.restart_at = Some(Instant::now() + RESTART_DELAY);
            self.synthetic("app.restarting");
        } else { self.crash_latched = true; self.log("error", "Sidecar restart budget exhausted (5 in 60 seconds); use RESTART"); }
    }

    fn terminate(&mut self) {
        if let Some(mut child) = self.child.take() {
            self.generation += 1;
            // Queue graceful shutdown, close the input queue (the writer then
            // closes stdin/EOF), and enforce a two-second kill deadline. Input
            // writes run separately so a child that stops reading cannot block
            // window close. Child::kill uses TerminateProcess on Windows.
            if let Some(input) = self.input.take() { let _ = input.try_send("shutdown"); }
            let deadline = Instant::now() + SHUTDOWN_GRACE;
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => return,
                    Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
                    _ => break,
                }
            }
            if child.kill().is_ok() { let _ = child.wait(); }
            else { self.log("error", "Could not terminate sidecar process"); }
        }
    }
}

impl Drop for Worker { fn drop(&mut self) { self.terminate(); } }

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::{fs, sync::atomic::AtomicUsize};

    static SEQUENCE: AtomicUsize = AtomicUsize::new(0);

    struct Fixture { root: PathBuf, supervisor: Supervisor, events: Arc<Mutex<Vec<Value>>> }
    impl Fixture {
        fn new(auto: bool, mode: &str) -> Self {
            Self::with_config(json!({"nodePath":"/usr/bin/python3", "autoUplink":auto, "fixtureMode":mode,
                "serverUrl":"http://127.0.0.1:1", "ingestToken":"PLACEHOLDER-TOKEN"}))
        }
        fn with_config(settings: Value) -> Self {
            let root = std::env::temp_dir().join(format!("msfslogger-supervisor-{}-{}", std::process::id(), SEQUENCE.fetch_add(1, Ordering::SeqCst)));
            fs::create_dir_all(root.join("dist")).unwrap();
            let entry = root.join("dist/index.js");
            fs::write(&entry, include_str!("../tests/fake-sidecar.py")).unwrap();
            let config = ConfigStore::new(root.join("config.json"));
            config.save(settings).unwrap();
            let events = Arc::new(Mutex::new(Vec::new()));
            let captured = events.clone();
            let sink = Arc::new(move |event| {
                let value = match event { Event::Status(v) | Event::Log(v) | Event::Exit(v) => v };
                lock(&captured).push(value);
            });
            let supervisor = Supervisor::new(config, Some(entry), sink).unwrap();
            Self { root, supervisor, events }
        }
        fn wait(&self, predicate: impl Fn() -> bool, seconds: u64) {
            let deadline = Instant::now() + Duration::from_secs(seconds);
            while !predicate() {
                assert!(Instant::now() < deadline, "Timed out waiting for fixture state");
                thread::sleep(Duration::from_millis(20));
            }
        }
        fn state(&self) -> String {
            lock(&self.supervisor.snapshot).status.as_ref().unwrap()["app"]["state"].as_str().unwrap().to_owned()
        }
        fn problems(&self) -> Value {
            lock(&self.supervisor.snapshot).status.as_ref().unwrap()["app"]["problems"].clone()
        }
        fn pid(&self) -> u64 { lock(&self.supervisor.snapshot).hello.as_ref().unwrap()["pid"].as_u64().unwrap() }
        fn starts(&self) -> usize { fs::read_to_string(self.root.join("starts")).unwrap_or_default().lines().count() }
        fn controls(&self) -> String { fs::read_to_string(self.root.join("controls")).unwrap_or_default() }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { self.supervisor.shutdown(); let _ = fs::remove_dir_all(&self.root); }
    }

    #[test]
    fn manual_start_stop_redaction_and_graceful_close() {
        let fixture = Fixture::new(false, "normal");
        // Spawned at launch so the sidecar can report on itself, but idle:
        // without autoUplink nothing starts the uplink until the user does.
        fixture.wait(|| fixture.state() == "app.stopped", 3);
        assert_eq!(fixture.starts(), 1);
        assert_eq!(fixture.controls(), "");
        fixture.supervisor.request(Operation::Start).unwrap();
        fixture.wait(|| fixture.state() == "app.running", 3);
        assert_eq!(fixture.controls(), "start\n");
        let pid = fixture.pid();
        fixture.supervisor.request(Operation::Stop).unwrap();
        fixture.wait(|| fixture.state() == "app.stopped", 3);
        assert!(PathBuf::from(format!("/proc/{pid}")).exists());
        assert_eq!(fixture.starts(), 1);
        let recorded = serde_json::to_string(&*lock(&fixture.events)).unwrap();
        assert!(!recorded.contains("PLACEHOLDER-TOKEN"));
        assert!(recorded.contains("Dropped malformed"));
        assert!(recorded.contains("[REDACTED]"));
        fixture.supervisor.shutdown();
        assert!(!PathBuf::from(format!("/proc/{pid}")).exists());
        assert!(fs::read_to_string(fixture.root.join("controls")).unwrap().contains("shutdown"));
    }

    #[test]
    fn a_config_that_parses_but_is_invalid_reports_the_sidecar_state_and_its_problems() {
        // The shell must not read meaning into the file: a config that parses
        // is not a config that works, and only the sidecar knows the rules.
        let fixture = Fixture::with_config(json!({"nodePath":"/usr/bin/python3", "autoUplink":false,
            "serverUrl":"ftp://nope", "ingestToken":"", "sim":"2019"}));
        fixture.wait(|| fixture.state() == "app.error-config", 3);
        assert_eq!(fixture.problems()[0]["field"], "serverUrl");
        assert_eq!(fixture.starts(), 1);
        // START stays the sidecar's to refuse; the shell invents no running state.
        fixture.supervisor.request(Operation::Start).unwrap();
        thread::sleep(Duration::from_millis(200));
        assert_eq!(fixture.state(), "app.error-config");
        assert_eq!(fixture.starts(), 1);
    }

    #[test]
    fn auto_uplink_is_the_only_thing_that_starts_the_uplink_at_launch() {
        let auto = Fixture::new(true, "normal");
        auto.wait(|| auto.state() == "app.running", 3);
        assert_eq!(auto.controls(), "start\n");
        let manual = Fixture::new(false, "normal");
        manual.wait(|| manual.state() == "app.stopped", 3);
        thread::sleep(Duration::from_millis(200));
        assert_eq!(manual.controls(), "");
        assert_eq!(manual.starts(), 1);
    }

    #[test]
    fn stalled_child_is_killed_at_shutdown_deadline() {
        let fixture = Fixture::new(true, "stalled");
        fixture.wait(|| lock(&fixture.supervisor.snapshot).hello.is_some(), 3);
        let pid = fixture.pid();
        let start = Instant::now();
        fixture.supervisor.shutdown();
        assert!(start.elapsed() >= SHUTDOWN_GRACE);
        assert!(start.elapsed() < SHUTDOWN_GRACE + Duration::from_secs(1));
        assert!(!PathBuf::from(format!("/proc/{pid}")).exists());
    }

    #[test]
    fn crash_loop_stops_after_five_restarts_and_manual_restart_resets_budget() {
        let fixture = Fixture::new(true, "crash");
        fixture.wait(|| lock(&fixture.events).iter().any(|e| e.get("restarting") == Some(&Value::Bool(false))), 15);
        assert_eq!(fixture.starts(), 6);
        assert_eq!(fixture.state(), "app.crashed");
        fixture.supervisor.request(Operation::Stop).unwrap();
        fixture.supervisor.request(Operation::Start).unwrap();
        thread::sleep(Duration::from_millis(150));
        assert_eq!(fixture.starts(), 6);
        assert_eq!(fixture.state(), "app.crashed");
        fixture.supervisor.config.save(json!({"fixtureMode":"normal"})).unwrap();
        fixture.supervisor.request(Operation::Restart).unwrap();
        fixture.wait(|| fixture.state() == "app.running", 3);
        assert_eq!(fixture.starts(), 7);
        assert!(lock(&fixture.events).iter().any(|e| e.get("restartsRemaining") == Some(&json!(4))));
    }
}

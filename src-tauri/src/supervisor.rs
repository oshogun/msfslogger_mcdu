use crate::{
    config::{lock, ConfigStore},
    datalink::{self, DatalinkRelay},
    framing::{self, Line},
    protocol::{self, DecodeError},
    restart::{RestartBudget, RESTART_DELAY, SHUTDOWN_GRACE},
};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    io::{BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[derive(Clone)]
pub enum Event {
    Status(Value),
    Log(Value),
    Exit(Value),
    Datalink(Value),
}
pub type EventSink = Arc<dyn Fn(Event) + Send + Sync>;

#[derive(Clone)]
pub enum Operation {
    Start,
    Stop,
    Restart,
    Reload,
    Datalink { id: String, line: String },
}

/// What the stdin writer thread sends to the sidecar, one line per item.
enum Input {
    Control(&'static str),
    Line(String),
}

#[derive(Default)]
pub struct Snapshot {
    pub status: Option<Value>,
    pub hello: Option<Value>,
    pub pong: Option<Value>,
    pub datalink: Option<Value>,
    logs: VecDeque<Value>,
}

#[derive(Clone)]
pub struct Supervisor {
    pub config: Arc<ConfigStore>,
    pub snapshot: Arc<Mutex<Snapshot>>,
    requests: SyncSender<Operation>,
    stopping: Arc<AtomicBool>,
    sink: EventSink,
    relay: Arc<DatalinkRelay>,
    relay_timeouts: datalink::RelayTimeouts,
    // Set while a SimBrief prefile is outstanding, so a second press is refused
    // here rather than creating a second planned leg.
    prefile_in_flight: Arc<AtomicBool>,
    // Set while a clearance request is outstanding. The server writes logbook
    // rows for the first one, so a second press is refused rather than sent.
    clearance_in_flight: Arc<AtomicBool>,
    // One flag for every SayIntentions write. Each is one press against one
    // upstream session, so interleaving a link with an import is meaningless,
    // and a second press is refused while the first one's fate is open.
    sayintentions_in_flight: Arc<AtomicBool>,
    worker: Arc<WorkerHandle>,
}

/// Holds an in-flight flag for one relayed write and releases it on every way
/// out: an answer, a timeout, an exited sidecar or a refused queue.
struct InFlightGuard(Arc<AtomicBool>);

impl InFlightGuard {
    fn acquire(flag: &Arc<AtomicBool>) -> Option<Self> {
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self(flag.clone()))
    }
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl Supervisor {
    pub fn new(
        config: ConfigStore,
        resource_entry: Option<PathBuf>,
        sink: EventSink,
    ) -> Result<Self, String> {
        let config = Arc::new(config);
        // The only thing the shell reads out of the file is autoUplink, which
        // is its own decision to act on. Whether the config is usable at all
        // is the sidecar's judgement, reported by the sidecar, so there is no
        // second set of validation rules here to drift out of step.
        let auto_uplink = config
            .read()
            .ok()
            .flatten()
            .and_then(|raw| raw.get("autoUplink").and_then(Value::as_bool))
            .unwrap_or(false);
        let snapshot = Arc::new(Mutex::new(Snapshot {
            status: Some(protocol::idle_status("app.starting")),
            ..Snapshot::default()
        }));
        let stopping = Arc::new(AtomicBool::new(false));
        let relay = Arc::new(DatalinkRelay::default());
        let (requests, receiver) = mpsc::sync_channel(64);
        let (lines, stream) = mpsc::sync_channel(128);
        let mut worker = Worker {
            config: config.clone(),
            snapshot: snapshot.clone(),
            stopping: stopping.clone(),
            sink: sink.clone(),
            relay: relay.clone(),
            resource_entry,
            child: None,
            input: None,
            generation: 0,
            lines,
            stream,
            budget: RestartBudget::default(),
            restart_at: None,
            desired_running: auto_uplink,
            version_error_logged: false,
            crash_latched: false,
        };
        let thread = thread::Builder::new()
            .name("sidecar-supervisor".into())
            .spawn(move || {
                // The sidecar always runs, so it can report on its own config and
                // on the sim. Manual START stays the baseline for the uplink: an
                // absent or non-boolean autoUplink reads false, and then nothing
                // is posted to the server until the user presses START.
                worker.spawn();
                worker.run(receiver);
            })
            .map_err(|_| "Cannot start sidecar supervisor")?;
        Ok(Self {
            config,
            snapshot,
            requests,
            stopping: stopping.clone(),
            sink,
            relay,
            relay_timeouts: datalink::RelayTimeouts::PRODUCTION,
            prefile_in_flight: Arc::new(AtomicBool::new(false)),
            clearance_in_flight: Arc::new(AtomicBool::new(false)),
            sayintentions_in_flight: Arc::new(AtomicBool::new(false)),
            worker: Arc::new(WorkerHandle {
                stopping,
                thread: Mutex::new(Some(thread)),
            }),
        })
    }

    pub fn request(&self, operation: Operation) -> Result<(), String> {
        if self.stopping.load(Ordering::Acquire) {
            return Err("App is shutting down".into());
        }
        self.requests
            .try_send(operation)
            .map_err(|_| "Sidecar supervisor is busy or unavailable".into())
    }

    pub fn shutdown(&self) {
        self.worker.shutdown();
    }

    #[cfg(test)]
    pub fn with_relay_timeouts(mut self, timeouts: datalink::RelayTimeouts) -> Self {
        self.relay_timeouts = timeouts;
        self
    }

    /// Relays one datalink op to the sidecar and waits for its answer. Always
    /// returns an envelope, and never waits longer than the relay deadline.
    pub fn datalink(&self, op: &str, params: Value) -> Value {
        let mut envelope = self.relay_datalink(op, params);
        self.config.redact(&mut envelope);
        envelope
    }

    fn relay_datalink(&self, op: &str, params: Value) -> Value {
        if self.stopping.load(Ordering::Acquire) {
            return datalink::error_envelope("sidecar-unavailable");
        }
        let (refused, simbrief, clearance, sayintentions) = {
            let mut snapshot = lock(&self.snapshot);
            let simbrief = snapshot
                .hello
                .as_ref()
                .is_some_and(datalink::supports_simbrief);
            let clearance = snapshot
                .hello
                .as_ref()
                .is_some_and(datalink::supports_clearance);
            let sayintentions = snapshot
                .hello
                .as_ref()
                .is_some_and(datalink::supports_sayintentions);
            let state = match snapshot.hello.as_ref() {
                None => Some(datalink::STATE_UNAVAILABLE),
                Some(hello) if !datalink::supports_datalink(hello) => {
                    Some(datalink::STATE_OUTDATED)
                }
                Some(_) => None,
            };
            let refused = state.map(|state| {
                let current = snapshot
                    .datalink
                    .as_ref()
                    .is_some_and(|value| value["state"] == state);
                let synthetic = (!current).then(|| datalink::synthetic_state(state));
                if synthetic.is_some() {
                    snapshot.datalink = synthetic.clone();
                }
                (state, synthetic)
            });
            (refused, simbrief, clearance, sayintentions)
        };
        if let Some((state, synthetic)) = refused {
            if let Some(value) = synthetic {
                (self.sink)(Event::Datalink(value));
            }
            return datalink::error_envelope(if state == datalink::STATE_OUTDATED {
                "sidecar-outdated"
            } else {
                "sidecar-unavailable"
            });
        }
        // A sidecar that has the datalink but not SimBrief keeps its datalink
        // state untouched: only these ops are out of date.
        if datalink::SIMBRIEF_OPS.contains(&op) && !simbrief {
            return datalink::error_envelope("sidecar-outdated");
        }
        // Likewise a sidecar that predates the clearance op: nothing is written
        // and the datalink state is left as it is.
        if datalink::CLEARANCE_OPS.contains(&op) && !clearance {
            return datalink::error_envelope("sidecar-outdated");
        }
        // And a sidecar that predates the SayIntentions ops: nothing is sent,
        // nothing is written and the datalink state is left as it is.
        if datalink::SAYINTENTIONS_OPS.contains(&op) && !sayintentions {
            return datalink::error_envelope("sidecar-outdated");
        }
        if !datalink::valid_params(op, &params) {
            return datalink::error_envelope("bad-request");
        }
        let _prefile = if op == "simbrief-prefile" {
            match InFlightGuard::acquire(&self.prefile_in_flight) {
                Some(guard) => Some(guard),
                None => return datalink::error_envelope("prefile-in-progress"),
            }
        } else {
            None
        };
        let _clearance = if op == "clearance" {
            match InFlightGuard::acquire(&self.clearance_in_flight) {
                Some(guard) => Some(guard),
                None => return datalink::error_envelope("clearance-in-progress"),
            }
        } else {
            None
        };
        // One guard for all four SayIntentions writes, so a second press cannot
        // reach the upstream while the first one's fate is open — including a
        // press that crosses from one page to another. The status read takes no
        // guard: the pages discard a stale answer by themselves.
        let _sayintentions = if matches!(op, "si-link" | "si-unlink" | "si-import" | "si-pdc") {
            match InFlightGuard::acquire(&self.sayintentions_in_flight) {
                Some(guard) => Some(guard),
                None => return datalink::error_envelope("sayintentions-in-progress"),
            }
        } else {
            None
        };
        let (id, reply) = match self.relay.register() {
            Ok(registered) => registered,
            Err(busy) => return busy,
        };
        let Some(line) = datalink::request_line(&id, op, &params) else {
            self.relay.abandon(&id);
            return datalink::error_envelope("bad-request");
        };
        let queued = Operation::Datalink {
            id: id.clone(),
            line,
        };
        if self.requests.try_send(queued).is_err() {
            self.relay.abandon(&id);
            return datalink::error_envelope("busy");
        }
        match reply.recv_timeout(self.relay_timeouts.for_op(op)) {
            Ok(envelope) => envelope,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.relay.abandon(&id);
                // An answer that landed between the timeout and the abandon
                // is still the right answer.
                if let Ok(envelope) = reply.try_recv() {
                    return envelope;
                }
                record_log(
                    &self.config,
                    &self.snapshot,
                    &self.sink,
                    "warn",
                    "Datalink request timed out",
                );
                datalink::error_envelope("shell-timeout")
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => datalink::error_envelope("sidecar-exited"),
        }
    }

    /// The latest datalink state, without waiting on the sidecar.
    pub fn current_datalink_state(&self) -> Value {
        let snapshot = lock(&self.snapshot);
        let mut value = match (snapshot.datalink.as_ref(), snapshot.hello.as_ref()) {
            (Some(state), _) => state.clone(),
            (None, None) => datalink::synthetic_state(datalink::STATE_UNAVAILABLE),
            (None, Some(hello)) if !datalink::supports_datalink(hello) => {
                datalink::synthetic_state(datalink::STATE_OUTDATED)
            }
            // A current sidecar whose own first state has not arrived yet.
            (None, Some(_)) => Value::Null,
        };
        drop(snapshot);
        self.config.redact(&mut value);
        value
    }
}

// The supervisor is cloneable, so stop-on-drop lives on the shared worker
// handle: only the last clone going away stops the sidecar.
struct WorkerHandle {
    stopping: Arc<AtomicBool>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl WorkerHandle {
    fn shutdown(&self) {
        // A separate flag gives close/exit priority over queued button presses.
        self.stopping.store(true, Ordering::Release);
        if let Some(worker) = lock(&self.thread).take() {
            let _ = worker.join();
        }
    }
}

impl Drop for WorkerHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct StreamLine {
    generation: u64,
    stderr: bool,
    line: Line,
}

struct Worker {
    config: Arc<ConfigStore>,
    snapshot: Arc<Mutex<Snapshot>>,
    stopping: Arc<AtomicBool>,
    sink: EventSink,
    relay: Arc<DatalinkRelay>,
    resource_entry: Option<PathBuf>,
    child: Option<Child>,
    input: Option<SyncSender<Input>>,
    generation: u64,
    lines: SyncSender<StreamLine>,
    stream: Receiver<StreamLine>,
    budget: RestartBudget,
    restart_at: Option<Instant>,
    desired_running: bool,
    version_error_logged: bool,
    crash_latched: bool,
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
        Some(s)
            if s.starts_with(r"\\?\")
                && !s[4..].starts_with("UNC\\")
                && !s[4..].starts_with("Volume") =>
        {
            PathBuf::from(&s[4..])
        }
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
                let Ok(line) = self.stream.try_recv() else {
                    break;
                };
                // A dead child may leave logs queued behind its exit. Keep
                // those diagnostics, but never let its late status undo the
                // synthetic crashed/restarting state or a newer child's state.
                let current = line.generation == self.generation;
                self.read_output(line, current);
            }
            if let Some(child) = self.child.as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        self.child.take();
                        self.input.take();
                        let exited = self.generation;
                        self.generation += 1;
                        self.datalink_lost(exited);
                        self.unexpected_exit(status);
                    }
                    Ok(None) => {}
                    Err(_) => {
                        self.log("error", "Cannot inspect sidecar process; stopping it");
                        self.terminate();
                        self.synthetic("app.crashed");
                    }
                }
            }
            if self.restart_at.is_some_and(|at| Instant::now() >= at)
                && !self.stopping.load(Ordering::Acquire)
            {
                self.restart_at = None;
                self.spawn();
            }
        }
        self.restart_at = None;
        self.terminate();
        // Requests still queued behind the stop would otherwise wait out the
        // whole relay deadline for a worker that is gone.
        while let Ok(operation) = requests.try_recv() {
            if let Operation::Datalink { id, .. } = operation {
                self.relay.fail_unbound(&id, "sidecar-unavailable");
            }
        }
    }

    fn apply(&mut self, operation: Operation) {
        match operation {
            Operation::Start => {
                self.desired_running = true;
                if self.child.is_some() {
                    self.control("start");
                }
                // START cannot bypass an exhausted crash budget; RESTART is
                // the explicit action that clears it.
                else if self.crash_latched {
                    self.log("warn", "Sidecar stopped after failure; use RESTART");
                } else if self.restart_at.is_none() {
                    self.spawn();
                }
            }
            Operation::Stop => {
                self.desired_running = false;
                self.restart_at = None;
                // A live sidecar reports its own state after a stop. A dead
                // one is a fault, and saying "stopped" for it would claim a
                // working config nobody has checked.
                if self.child.is_some() {
                    self.control("stop");
                } else {
                    self.synthetic("app.crashed");
                }
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
                if self.child.is_some() {
                    self.control("config");
                } else if self.restart_at.is_none() {
                    self.synthetic("app.crashed");
                }
            }
            Operation::Datalink { id, line } => {
                let Some(input) = self.input.as_ref().filter(|_| self.child.is_some()) else {
                    self.relay.fail_unbound(&id, "sidecar-unavailable");
                    return;
                };
                if input.try_send(Input::Line(line)).is_err() {
                    self.relay.fail_unbound(&id, "busy");
                } else {
                    self.relay.bind_generation(&id, self.generation);
                }
            }
        }
    }

    fn spawn(&mut self) {
        if self.child.is_some() || self.stopping.load(Ordering::Acquire) {
            return;
        }
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
            .join("sidecar")
            .join("dist")
            .join("index.js");
        let entry = self
            .resource_entry
            .as_ref()
            .filter(|path| path.is_file())
            .cloned()
            .or_else(|| development.is_file().then_some(development.clone()));
        let Some(entry) = entry else {
            self.crash_latched = true;
            self.log(
                "error",
                &format!(
                    "Sidecar entry missing; tried {} and {}",
                    self.resource_entry
                        .as_ref()
                        .map(|p| p.display().to_string())
                        .unwrap_or_else(|| {
                            "<unavailable resource directory>/sidecar/dist/index.js".into()
                        }),
                    development.display()
                ),
            );
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
        let node = raw
            .as_ref()
            .and_then(|raw| raw.get("nodePath"))
            .and_then(Value::as_str)
            .filter(|path| !path.trim().is_empty())
            .unwrap_or("node");
        let Some(directory) = entry.parent().and_then(|dist| dist.parent()) else {
            self.log("error", "Sidecar entry has no parent directory");
            self.synthetic("app.crashed");
            return;
        };
        let mut command = Command::new(node);
        command
            .arg(&entry)
            .arg("--config")
            .arg(&self.config.path)
            .current_dir(directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Inherit the environment unchanged. Credentials and CA configuration
        // travel only through the file, never through argv or injected env vars.
        #[cfg(windows)]
        {
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
                let input = stdin
                    .ok_or_else(|| std::io::Error::other("Missing child stdin"))
                    .and_then(|pipe| self.writer(pipe));
                if input.is_err() {
                    self.log("error", "Cannot start sidecar input writer");
                    self.terminate();
                    self.synthetic("app.crashed");
                    return;
                }
                let readers = stdout
                    .map(|pipe| self.reader(pipe, false))
                    .transpose()
                    .and_then(|_| stderr.map(|pipe| self.reader(pipe, true)).transpose());
                if readers.is_err() {
                    self.log("error", "Cannot start sidecar output reader");
                    self.terminate();
                    self.synthetic("app.crashed");
                    return;
                }
                self.log("info", "Sidecar process started");
                // A fresh sidecar is idle and reports so itself; it is only
                // told to start when autoUplink or the user asked for it.
                if self.desired_running {
                    self.control("start");
                }
            }
            Err(_) => {
                self.crash_latched = true;
                self.log(
                    "error",
                    "Cannot launch sidecar; install Node 20 on PATH or set nodePath in config.json",
                );
                self.synthetic("app.crashed");
            }
        }
    }

    fn reader(&self, pipe: impl Read + Send + 'static, stderr: bool) -> std::io::Result<()> {
        let sender = self.lines.clone();
        let generation = self.generation;
        thread::Builder::new()
            .name(
                if stderr {
                    "sidecar-stderr"
                } else {
                    "sidecar-stdout"
                }
                .into(),
            )
            .spawn(move || {
                let mut reader = BufReader::new(pipe);
                loop {
                    match framing::read_line(&mut reader) {
                        Ok(Some(line)) => {
                            if sender
                                .send(StreamLine {
                                    generation,
                                    stderr,
                                    line,
                                })
                                .is_err()
                            {
                                break;
                            }
                        }
                        Ok(None) => break,
                        Err(_) => {
                            let _ = sender.send(StreamLine {
                                generation,
                                stderr: true,
                                line: Line::Text("Sidecar output pipe read failed".into()),
                            });
                            break;
                        }
                    }
                }
            })
            .map(|_| ())
    }

    fn writer(&mut self, mut stdin: std::process::ChildStdin) -> std::io::Result<()> {
        // Room for every pending datalink line plus controls, so a burst of
        // datalink requests never starves START/STOP.
        let (sender, receiver) = mpsc::sync_channel::<Input>(16);
        thread::Builder::new()
            .name("sidecar-stdin".into())
            .spawn(move || {
                for input in receiver {
                    if !matches!(write_input(&mut stdin, &input), Ok(true)) {
                        break;
                    }
                }
                // Dropping this handle sends EOF, including when the supervisor
                // closes its queue. A stuck write cannot block the kill deadline.
            })?;
        self.input = Some(sender);
        Ok(())
    }

    fn control(&mut self, kind: &'static str) {
        if self
            .input
            .as_ref()
            .is_some_and(|input| input.try_send(Input::Control(kind)).is_err())
        {
            self.log(
                "warn",
                "Cannot queue sidecar control; input is busy or closed",
            );
        }
    }

    fn read_output(&mut self, line: StreamLine, current: bool) {
        let text = match line.line {
            Line::Oversize => {
                self.log("warn", "Dropped sidecar line larger than 65536 bytes");
                return;
            }
            Line::InvalidUtf8 => {
                self.log("warn", "Dropped sidecar line with invalid UTF-8");
                return;
            }
            Line::Text(text) => text,
        };
        if text.trim().is_empty() {
            return;
        }
        if line.stderr {
            self.log("error", &text);
            return;
        }
        match protocol::decode(&text) {
            Ok(mut value) => {
                self.config.redact(&mut value);
                match value["type"].as_str() {
                    Some("status") if current => self.status(value),
                    Some("log") => self.log_value(value),
                    Some("hello") if current => self.hello(value),
                    Some("pong") if current => lock(&self.snapshot).pong = Some(value),
                    // A response is matched by id and by the generation it was
                    // sent to, so one from a replaced sidecar is simply unknown.
                    Some("datalink-response") => {
                        let envelope = datalink::response_envelope(&value);
                        let id = value["id"].as_str().unwrap_or_default();
                        if !self.relay.complete(id, line.generation, envelope) {
                            self.log("warn", "Dropped datalink response with an unknown id");
                        }
                    }
                    Some("datalink-state") if current => self.set_datalink_state(value),
                    _ => {} // Reserved messages have no webview events yet.
                }
            }
            // Never include the rejected bytes or parser details: a malformed
            // line can contain a token even though the normal protocol cannot.
            Err(DecodeError::BadVersion) => {
                if !self.version_error_logged {
                    self.log("error", "Sidecar protocol version mismatch; expected 1");
                    self.version_error_logged = true;
                }
            }
            Err(DecodeError::UnknownType) => {}
            Err(_) => self.log("warn", "Dropped malformed or non-JSON sidecar message"),
        }
    }

    fn hello(&self, value: Value) {
        let supported = datalink::supports_datalink(&value);
        let mut snapshot = lock(&self.snapshot);
        snapshot.hello = Some(value);
        if supported {
            // The sidecar reports its own datalink state right after hello.
            snapshot.datalink = None;
        } else {
            drop(snapshot);
            self.set_datalink_state(datalink::synthetic_state(datalink::STATE_OUTDATED));
        }
    }

    fn set_datalink_state(&self, value: Value) {
        lock(&self.snapshot).datalink = Some(value.clone());
        (self.sink)(Event::Datalink(value));
    }

    /// Everything waiting on the sidecar that just went away is answered now
    /// rather than at the relay deadline.
    fn datalink_lost(&self, generation: u64) {
        self.relay.fail_generation(generation);
        self.set_datalink_state(datalink::synthetic_state(datalink::STATE_UNAVAILABLE));
    }

    fn status(&self, value: Value) {
        lock(&self.snapshot).status = Some(value.clone());
        (self.sink)(Event::Status(value));
    }

    fn synthetic(&self, state: &str) {
        let mut value = lock(&self.snapshot)
            .status
            .clone()
            .unwrap_or_else(|| protocol::idle_status(state));
        value["at"] = json!(protocol::now());
        value["app"] = json!({"state": state});
        value["sim"]["state"] = json!("sim.idle");
        value["sim"]["nextRetryAt"] = Value::Null;
        value["sim"]["retryDelayMs"] = Value::Null;
        value["backend"]["state"] = json!("net.idle");
        self.status(value);
    }

    fn log(&self, level: &str, text: &str) {
        record_log(&self.config, &self.snapshot, &self.sink, level, text);
    }

    fn log_value(&self, value: Value) {
        record_log_value(&self.snapshot, &self.sink, value);
    }

    fn unexpected_exit(&mut self, status: ExitStatus) {
        let remaining = self.budget.reserve(Instant::now());
        #[cfg(unix)]
        let signal = {
            use std::os::unix::process::ExitStatusExt;
            status.signal().map(|signal| signal.to_string())
        };
        #[cfg(not(unix))]
        let signal: Option<String> = None;
        eprintln!(
            "[sidecar] exited: code={:?} signal={:?}",
            status.code(),
            signal
        );
        (self.sink)(Event::Exit(
            json!({"code":status.code(), "signal":signal, "restarting":remaining.is_some(), "restartsRemaining":remaining.unwrap_or(0)}),
        ));
        self.synthetic("app.crashed");
        if remaining.is_some() {
            self.restart_at = Some(Instant::now() + RESTART_DELAY);
            self.synthetic("app.restarting");
        } else {
            self.crash_latched = true;
            self.log(
                "error",
                "Sidecar restart budget exhausted (5 in 60 seconds); use RESTART",
            );
        }
    }

    fn terminate(&mut self) {
        if let Some(mut child) = self.child.take() {
            let exited = self.generation;
            self.generation += 1;
            // Queue graceful shutdown, close the input queue (the writer then
            // closes stdin/EOF), and enforce a two-second kill deadline. Input
            // writes run separately so a child that stops reading cannot block
            // window close. Child::kill uses TerminateProcess on Windows.
            if let Some(input) = self.input.take() {
                let _ = input.try_send(Input::Control("shutdown"));
            }
            self.datalink_lost(exited);
            let deadline = Instant::now() + SHUTDOWN_GRACE;
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => return,
                    Ok(None) if Instant::now() < deadline => {
                        thread::sleep(Duration::from_millis(20))
                    }
                    _ => break,
                }
            }
            if child.kill().is_ok() {
                let _ = child.wait();
            } else {
                self.log("error", "Could not terminate sidecar process");
            }
        }
    }
}

/// Writes one queued item; false means the writer is done after this line.
fn write_input(out: &mut impl Write, input: &Input) -> std::io::Result<bool> {
    match input {
        Input::Control(kind) => {
            writeln!(out, "{}", json!({"v":1,"type":kind}))?;
            out.flush()?;
            Ok(*kind != "shutdown")
        }
        Input::Line(line) => {
            writeln!(out, "{line}")?;
            out.flush()?;
            Ok(true)
        }
    }
}

fn record_log(
    config: &ConfigStore,
    snapshot: &Mutex<Snapshot>,
    sink: &EventSink,
    level: &str,
    text: &str,
) {
    let message = config.redact_text(text);
    // Also visible in the `cargo tauri dev` terminal itself, not just the
    // webview's one-line scratchpad — the scratchpad only ever shows the
    // latest message, so a fast crash loop's real cause is otherwise gone
    // by the time anyone looks at the window.
    eprintln!("[sidecar:{level}] {message}");
    record_log_value(
        snapshot,
        sink,
        json!({"v":1, "type":"log", "at":protocol::now(), "level":level, "message":message}),
    );
}

fn record_log_value(snapshot: &Mutex<Snapshot>, sink: &EventSink, value: Value) {
    {
        let mut cache = lock(snapshot);
        if cache.logs.len() == 200 {
            cache.logs.pop_front();
        }
        cache.logs.push_back(value.clone());
    }
    sink(Event::Log(value));
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[cfg(test)]
mod handle_tests {
    use super::*;

    #[test]
    fn dropping_a_clone_keeps_the_supervisor_running() {
        let root = std::env::temp_dir().join(format!(
            "msfslogger-supervisor-clone-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let config = ConfigStore::new(root.join("config.json"));
        // A missing node binary keeps this test from launching a real sidecar.
        config
            .save(json!({"nodePath": root.join("missing-node.exe")}))
            .unwrap();
        let supervisor = Supervisor::new(config, None, Arc::new(|_: Event| {})).unwrap();
        drop(supervisor.clone());
        assert!(!supervisor.stopping.load(Ordering::Acquire));
        assert!(supervisor.request(Operation::Stop).is_ok());
        supervisor.shutdown();
        assert!(supervisor.request(Operation::Stop).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::{fs, sync::atomic::AtomicUsize};

    static SEQUENCE: AtomicUsize = AtomicUsize::new(0);

    struct Fixture {
        root: PathBuf,
        supervisor: Supervisor,
        events: Arc<Mutex<Vec<Value>>>,
    }
    impl Fixture {
        fn new(auto: bool, mode: &str) -> Self {
            Self::with_config(
                json!({"nodePath":"/usr/bin/python3", "autoUplink":auto, "fixtureMode":mode,
                "serverUrl":"http://127.0.0.1:1", "ingestToken":"PLACEHOLDER-TOKEN"}),
            )
        }
        fn with_config(settings: Value) -> Self {
            let root = std::env::temp_dir().join(format!(
                "msfslogger-supervisor-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::SeqCst)
            ));
            fs::create_dir_all(root.join("dist")).unwrap();
            let entry = root.join("dist/index.js");
            fs::write(&entry, include_str!("../tests/fake-sidecar.py")).unwrap();
            let config = ConfigStore::new(root.join("config.json"));
            config.save(settings).unwrap();
            let events = Arc::new(Mutex::new(Vec::new()));
            let captured = events.clone();
            let sink = Arc::new(move |event| {
                let value = match event {
                    Event::Status(v) | Event::Log(v) | Event::Exit(v) | Event::Datalink(v) => v,
                };
                lock(&captured).push(value);
            });
            let supervisor = Supervisor::new(config, Some(entry), sink).unwrap();
            Self {
                root,
                supervisor,
                events,
            }
        }
        fn wait(&self, predicate: impl Fn() -> bool, seconds: u64) {
            let deadline = Instant::now() + Duration::from_secs(seconds);
            while !predicate() {
                assert!(
                    Instant::now() < deadline,
                    "Timed out waiting for fixture state"
                );
                thread::sleep(Duration::from_millis(20));
            }
        }
        fn state(&self) -> String {
            lock(&self.supervisor.snapshot).status.as_ref().unwrap()["app"]["state"]
                .as_str()
                .unwrap()
                .to_owned()
        }
        fn problems(&self) -> Value {
            lock(&self.supervisor.snapshot).status.as_ref().unwrap()["app"]["problems"].clone()
        }
        fn pid(&self) -> u64 {
            lock(&self.supervisor.snapshot).hello.as_ref().unwrap()["pid"]
                .as_u64()
                .unwrap()
        }
        fn starts(&self) -> usize {
            fs::read_to_string(self.root.join("starts"))
                .unwrap_or_default()
                .lines()
                .count()
        }
        fn controls(&self) -> String {
            fs::read_to_string(self.root.join("controls")).unwrap_or_default()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.supervisor.shutdown();
            let _ = fs::remove_dir_all(&self.root);
        }
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
        assert!(fs::read_to_string(fixture.root.join("controls"))
            .unwrap()
            .contains("shutdown"));
    }

    #[test]
    fn a_config_that_parses_but_is_invalid_reports_the_sidecar_state_and_its_problems() {
        // The shell must not read meaning into the file: a config that parses
        // is not a config that works, and only the sidecar knows the rules.
        let fixture =
            Fixture::with_config(json!({"nodePath":"/usr/bin/python3", "autoUplink":false,
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
        fixture.wait(
            || {
                lock(&fixture.events)
                    .iter()
                    .any(|e| e.get("restarting") == Some(&Value::Bool(false)))
            },
            15,
        );
        assert_eq!(fixture.starts(), 6);
        assert_eq!(fixture.state(), "app.crashed");
        fixture.supervisor.request(Operation::Stop).unwrap();
        fixture.supervisor.request(Operation::Start).unwrap();
        thread::sleep(Duration::from_millis(150));
        assert_eq!(fixture.starts(), 6);
        assert_eq!(fixture.state(), "app.crashed");
        fixture
            .supervisor
            .config
            .save(json!({"fixtureMode":"normal"}))
            .unwrap();
        fixture.supervisor.request(Operation::Restart).unwrap();
        fixture.wait(|| fixture.state() == "app.running", 3);
        assert_eq!(fixture.starts(), 7);
        assert!(lock(&fixture.events)
            .iter()
            .any(|e| e.get("restartsRemaining") == Some(&json!(4))));
    }
}

#[cfg(test)]
mod writer_tests {
    use super::*;

    #[test]
    fn control_messages_are_written_byte_for_byte_as_before() {
        let mut out = Vec::new();
        for kind in ["start", "stop", "config", "shutdown", "ping"] {
            let keep_going = write_input(&mut out, &Input::Control(kind)).unwrap();
            assert_eq!(keep_going, kind != "shutdown");
        }
        // Recorded from the writer before datalink lines shared its queue.
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "{\"type\":\"start\",\"v\":1}\n{\"type\":\"stop\",\"v\":1}\n{\"type\":\"config\",\"v\":1}\n{\"type\":\"shutdown\",\"v\":1}\n{\"type\":\"ping\",\"v\":1}\n"
        );
        let mut out = Vec::new();
        assert!(write_input(&mut out, &Input::Line("{\"v\":1}".into())).unwrap());
        assert_eq!(out, b"{\"v\":1}\n");
    }
}

// Runs the Python fixture as the sidecar, on every platform, so the relay is
// exercised against a real child process and real pipes.
#[cfg(test)]
mod datalink_process_tests {
    use super::*;
    use std::{fs, sync::atomic::AtomicUsize};

    const SENTINEL: &str = "SENTINEL-DATALINK-TOKEN-0000";
    static SEQUENCE: AtomicUsize = AtomicUsize::new(0);

    fn python_path() -> &'static str {
        if cfg!(windows) {
            "python"
        } else {
            "/usr/bin/python3"
        }
    }

    struct Fixture {
        root: PathBuf,
        supervisor: Supervisor,
        events: Arc<Mutex<Vec<(&'static str, Value)>>>,
    }

    impl Fixture {
        fn new(mode: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "msfslogger-datalink-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::SeqCst)
            ));
            fs::create_dir_all(root.join("dist")).unwrap();
            let entry = root.join("dist").join("index.js");
            fs::write(&entry, include_str!("../tests/fake-sidecar.py")).unwrap();
            let config = ConfigStore::new(root.join("config.json"));
            config
                .save(
                    json!({"nodePath":python_path(), "autoUplink":false, "datalinkMode":mode,
                    "serverUrl":"http://127.0.0.1:1", "ingestToken":SENTINEL}),
                )
                .unwrap();
            let events = Arc::new(Mutex::new(Vec::new()));
            let captured = events.clone();
            let sink = Arc::new(move |event| {
                let recorded = match event {
                    Event::Status(v) => ("status", v),
                    Event::Log(v) => ("log", v),
                    Event::Exit(v) => ("exit", v),
                    Event::Datalink(v) => ("datalink", v),
                };
                lock(&captured).push(recorded);
            });
            let supervisor = Supervisor::new(config, Some(entry), sink).unwrap();
            let fixture = Self {
                root,
                supervisor,
                events,
            };
            fixture.wait(|| fixture.app_state() == "app.stopped", 10);
            fixture
        }

        fn wait(&self, predicate: impl Fn() -> bool, seconds: u64) {
            let deadline = Instant::now() + Duration::from_secs(seconds);
            while !predicate() {
                assert!(
                    Instant::now() < deadline,
                    "Timed out waiting for fixture state"
                );
                thread::sleep(Duration::from_millis(20));
            }
        }

        fn app_state(&self) -> String {
            lock(&self.supervisor.snapshot).status.as_ref().unwrap()["app"]["state"]
                .as_str()
                .unwrap()
                .to_owned()
        }

        fn backend(&self) -> Value {
            lock(&self.supervisor.snapshot).status.as_ref().unwrap()["backend"].clone()
        }

        fn count(&self, kind: &str) -> usize {
            lock(&self.events)
                .iter()
                .filter(|(k, _)| *k == kind)
                .count()
        }

        fn has_log(&self, message: &str) -> bool {
            lock(&self.events)
                .iter()
                .any(|(kind, v)| *kind == "log" && v["message"] == message)
        }

        fn has_datalink_state(&self, state: &str) -> bool {
            lock(&self.events)
                .iter()
                .any(|(kind, v)| *kind == "datalink" && v["state"] == state)
        }

        // One control type per line, whatever newline the platform wrote.
        fn controls(&self) -> Vec<String> {
            fs::read_to_string(self.root.join("controls"))
                .unwrap_or_default()
                .lines()
                .map(str::to_owned)
                .collect()
        }

        fn timed(&self, op: &str, params: Value) -> (Value, Duration) {
            let started = Instant::now();
            let envelope = self.supervisor.datalink(op, params);
            (envelope, started.elapsed())
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.supervisor.shutdown();
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn code(envelope: &Value) -> &str {
        envelope["error"]["code"].as_str().unwrap_or_default()
    }

    #[test]
    fn a_request_resolves_with_the_response_carrying_its_id() {
        let fixture = Fixture::new("answer");
        fixture.wait(|| fixture.has_datalink_state("dl.idle"), 5);
        let backend = fixture.backend();
        let statuses = fixture.count("status");
        let (envelope, _) = fixture.timed("watch", json!({"on":true}));
        assert_eq!(envelope, json!({"ok":true, "result":{"echo":"watch"}}));
        let (envelope, _) = fixture.timed(
            "wx",
            json!({"target":{"kind":"leg","id":12}, "icao":"LFPG"}),
        );
        assert_eq!(envelope, json!({"ok":true, "result":{"echo":"wx"}}));
        fixture.wait(|| fixture.has_datalink_state("dl.ok"), 5);
        assert_eq!(
            fixture.supervisor.current_datalink_state()["state"],
            "dl.ok"
        );
        assert_eq!(fixture.controls(), ["datalink-request", "datalink-request"]);
        // Invalid params never reach the sidecar.
        let (envelope, elapsed) = fixture.timed(
            "send-canned",
            json!({"target":{"kind":"flight","id":1}, "cannedId":"gate-request", "body":"FREE TEXT"}),
        );
        assert_eq!(code(&envelope), "bad-request");
        assert!(elapsed < Duration::from_secs(1));
        assert_eq!(fixture.controls(), ["datalink-request", "datalink-request"]);
        assert_eq!(fixture.backend(), backend);
        assert_eq!(fixture.count("status"), statuses);
    }

    #[test]
    fn datalink_errors_never_move_the_backend_status() {
        let fixture = Fixture::new("answer-error");
        fixture.wait(|| fixture.has_datalink_state("dl.idle"), 5);
        let backend = fixture.backend();
        let statuses = fixture.count("status");
        let (envelope, _) = fixture.timed("loadsheet", json!({"plannedLegId":12}));
        assert_eq!(
            envelope,
            json!({"ok":false, "error":{"code":"no-dispatch-data", "httpStatus":409, "serverCode":"NO_DISPATCH_DATA"}})
        );
        fixture.wait(|| fixture.has_datalink_state("dl.unavailable"), 5);
        assert_eq!(fixture.backend(), backend);
        assert_eq!(fixture.count("status"), statuses);
        assert_eq!(fixture.backend()["state"], "net.idle");
    }

    #[test]
    fn a_response_with_an_unknown_id_is_dropped_without_its_payload() {
        let fixture = Fixture::new("wrong-id");
        fixture.wait(|| fixture.has_datalink_state("dl.idle"), 5);
        let backend = fixture.backend();
        let (envelope, elapsed) = fixture.timed("refresh", json!({}));
        assert_eq!(code(&envelope), "shell-timeout");
        assert!(elapsed >= datalink::REQUEST_TIMEOUT);
        assert!(elapsed < datalink::REQUEST_TIMEOUT + Duration::from_secs(1));
        assert!(fixture.has_log("Dropped datalink response with an unknown id"));
        assert!(fixture.has_log("Datalink request timed out"));
        let logs = serde_json::to_string(&*lock(&fixture.events)).unwrap();
        assert!(!logs.contains("dl-999999"));
        assert!(!logs.contains("echo"));
        assert_eq!(fixture.backend(), backend);
    }

    #[test]
    fn an_ignored_request_times_out_and_the_pending_bound_refuses_the_ninth() {
        let fixture = Fixture::new("ignore");
        fixture.wait(|| lock(&fixture.supervisor.snapshot).hello.is_some(), 5);
        let backend = fixture.backend();
        let waiting: Vec<_> = (0..datalink::PENDING_MAX)
            .map(|_| {
                let supervisor = fixture.supervisor.clone();
                thread::spawn(move || {
                    let started = Instant::now();
                    (supervisor.datalink("refresh", json!({})), started.elapsed())
                })
            })
            .collect();
        fixture.wait(
            || fixture.supervisor.relay.pending() == datalink::PENDING_MAX,
            5,
        );
        let (envelope, elapsed) = fixture.timed("canned-list", json!({}));
        assert_eq!(code(&envelope), "busy");
        assert!(elapsed < Duration::from_secs(1));
        for waiter in waiting {
            let (envelope, elapsed) = waiter.join().unwrap();
            assert_eq!(code(&envelope), "shell-timeout");
            assert!(elapsed < datalink::REQUEST_TIMEOUT + Duration::from_secs(1));
        }
        assert_eq!(fixture.supervisor.relay.pending(), 0);
        // The supervisor is still serving everything else.
        assert!(lock(&fixture.supervisor.snapshot).status.is_some());
        assert_eq!(fixture.backend(), backend);
        fixture.supervisor.request(Operation::Start).unwrap();
        fixture.wait(|| fixture.app_state() == "app.running", 5);
        assert_eq!(
            fixture
                .controls()
                .iter()
                .filter(|c| *c == "datalink-request")
                .count(),
            datalink::PENDING_MAX
        );
    }

    #[test]
    fn a_sidecar_exit_fails_the_pending_request_promptly() {
        let fixture = Fixture::new("exit-on-request");
        fixture.wait(|| fixture.has_datalink_state("dl.idle"), 5);
        let (envelope, elapsed) = fixture.timed("watch", json!({"on":true}));
        assert_eq!(code(&envelope), "sidecar-exited");
        assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
        fixture.wait(
            || fixture.has_datalink_state(datalink::STATE_UNAVAILABLE),
            5,
        );
        assert_eq!(fixture.supervisor.relay.pending(), 0);
    }

    #[test]
    fn a_restart_fails_the_pending_request_promptly() {
        let fixture = Fixture::new("ignore");
        fixture.wait(|| lock(&fixture.supervisor.snapshot).hello.is_some(), 5);
        let supervisor = fixture.supervisor.clone();
        let waiter = thread::spawn(move || {
            let started = Instant::now();
            (supervisor.datalink("refresh", json!({})), started.elapsed())
        });
        fixture.wait(
            || fixture.controls().iter().any(|c| c == "datalink-request"),
            5,
        );
        fixture.supervisor.request(Operation::Restart).unwrap();
        let (envelope, elapsed) = waiter.join().unwrap();
        assert_eq!(code(&envelope), "sidecar-exited");
        assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
        fixture.wait(
            || fixture.has_datalink_state(datalink::STATE_UNAVAILABLE),
            5,
        );
    }

    #[test]
    fn a_sidecar_without_the_feature_is_refused_without_a_request() {
        let fixture = Fixture::new("no-features");
        fixture.wait(|| fixture.has_datalink_state(datalink::STATE_OUTDATED), 5);
        assert_eq!(
            fixture.supervisor.current_datalink_state()["state"],
            datalink::STATE_OUTDATED
        );
        for (op, params) in [
            ("watch", json!({"on":true})),
            ("thread", json!({"epoch":1, "endSeq":0})),
            ("loadsheet", json!({"plannedLegId":12})),
        ] {
            let (envelope, elapsed) = fixture.timed(op, params);
            assert_eq!(code(&envelope), "sidecar-outdated");
            assert!(elapsed < Duration::from_secs(1));
        }
        // The sidecar is reading stdin, so an absent line means none was sent.
        fixture.supervisor.request(Operation::Start).unwrap();
        fixture.wait(|| fixture.app_state() == "app.running", 5);
        assert_eq!(fixture.controls(), ["start"]);
        assert_eq!(fixture.count("datalink"), 1);
    }

    #[test]
    fn the_ingest_token_never_leaves_the_shell() {
        let fixture = Fixture::new("echo-token");
        fixture.wait(|| fixture.has_datalink_state("dl.idle"), 5);
        let (envelope, _) = fixture.timed("canned-list", json!({}));
        assert_eq!(envelope["ok"], true);
        assert_eq!(envelope["result"]["note"], "token [REDACTED]");
        fixture.wait(|| fixture.has_datalink_state("dl.ok"), 5);
        let state = fixture.supervisor.current_datalink_state();
        assert_eq!(state["scope"]["note"], "[REDACTED]");
        let events = serde_json::to_string(&*lock(&fixture.events)).unwrap();
        let logs = serde_json::to_string(&lock(&fixture.supervisor.snapshot).logs).unwrap();
        for output in [envelope.to_string(), state.to_string(), events, logs] {
            assert!(!output.contains(SENTINEL));
        }
        // The fixture also echoes the token in a log line and on stderr.
        assert!(fixture.has_log("redact [REDACTED]"));
    }
}

// The SimBrief ops through the relay, against the Python fixture, with relay
// deadlines scaled down so nothing waits the production 12 s or 30 s.
#[cfg(test)]
mod simbrief_process_tests {
    use super::*;
    use std::{fs, sync::atomic::AtomicUsize};

    const SENTINEL: &str = "SENTINEL-SIMBRIEF-TOKEN-0000";
    const SCALED: datalink::RelayTimeouts = datalink::RelayTimeouts {
        default: Duration::from_millis(1_000),
        prefile: Duration::from_millis(2_500),
        sayintentions: Duration::from_millis(2_000),
    };
    static SEQUENCE: AtomicUsize = AtomicUsize::new(0);

    fn python_path() -> &'static str {
        if cfg!(windows) {
            "python"
        } else {
            "/usr/bin/python3"
        }
    }

    struct Fixture {
        root: PathBuf,
        supervisor: Supervisor,
        events: Arc<Mutex<Vec<(&'static str, Value)>>>,
    }

    impl Fixture {
        fn new(mode: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "msfslogger-simbrief-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::SeqCst)
            ));
            fs::create_dir_all(root.join("dist")).unwrap();
            let entry = root.join("dist").join("index.js");
            fs::write(&entry, include_str!("../tests/fake-sidecar.py")).unwrap();
            let config = ConfigStore::new(root.join("config.json"));
            config
                .save(
                    json!({"nodePath":python_path(), "autoUplink":false, "datalinkMode":mode,
                    "prefileDelayMs":1500, "serverUrl":"http://127.0.0.1:1", "ingestToken":SENTINEL}),
                )
                .unwrap();
            let events = Arc::new(Mutex::new(Vec::new()));
            let captured = events.clone();
            let sink = Arc::new(move |event| {
                let recorded = match event {
                    Event::Status(v) => ("status", v),
                    Event::Log(v) => ("log", v),
                    Event::Exit(v) => ("exit", v),
                    Event::Datalink(v) => ("datalink", v),
                };
                lock(&captured).push(recorded);
            });
            let supervisor = Supervisor::new(config, Some(entry), sink)
                .unwrap()
                .with_relay_timeouts(SCALED);
            let fixture = Self {
                root,
                supervisor,
                events,
            };
            fixture.wait(|| fixture.app_state() == "app.stopped", 10);
            fixture.wait(|| fixture.count("datalink") >= 1, 5);
            fixture
        }

        fn wait(&self, predicate: impl Fn() -> bool, seconds: u64) {
            let deadline = Instant::now() + Duration::from_secs(seconds);
            while !predicate() {
                assert!(
                    Instant::now() < deadline,
                    "Timed out waiting for fixture state"
                );
                thread::sleep(Duration::from_millis(20));
            }
        }

        fn app_state(&self) -> String {
            lock(&self.supervisor.snapshot).status.as_ref().unwrap()["app"]["state"]
                .as_str()
                .unwrap()
                .to_owned()
        }

        fn backend(&self) -> Value {
            lock(&self.supervisor.snapshot).status.as_ref().unwrap()["backend"].clone()
        }

        fn count(&self, kind: &str) -> usize {
            lock(&self.events)
                .iter()
                .filter(|(k, _)| *k == kind)
                .count()
        }

        fn starts(&self) -> usize {
            fs::read_to_string(self.root.join("starts"))
                .unwrap_or_default()
                .lines()
                .count()
        }

        /// Every op the fixture received, one per request line, in order.
        fn ops(&self) -> Vec<String> {
            fs::read_to_string(self.root.join("datalink-ops"))
                .unwrap_or_default()
                .lines()
                .map(str::to_owned)
                .collect()
        }

        fn prefile_lines(&self) -> usize {
            self.ops()
                .iter()
                .filter(|op| *op == "simbrief-prefile")
                .count()
        }

        fn timed(&self, op: &str, params: Value) -> (Value, Duration) {
            let started = Instant::now();
            let envelope = self.supervisor.datalink(op, params);
            (envelope, started.elapsed())
        }

        fn spawn_prefile(&self) -> thread::JoinHandle<(Value, Duration)> {
            let supervisor = self.supervisor.clone();
            thread::spawn(move || {
                let started = Instant::now();
                (
                    supervisor.datalink("simbrief-prefile", json!({})),
                    started.elapsed(),
                )
            })
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.supervisor.shutdown();
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn code(envelope: &Value) -> &str {
        envelope["error"]["code"].as_str().unwrap_or_default()
    }

    /// The server's duplicate override, spelled so its key never appears in
    /// client source, even in a test.
    fn duplicate_override() -> Value {
        let mut params = serde_json::Map::new();
        params.insert(format!("allow{}duplicates", '_'), json!(true));
        Value::Object(params)
    }

    #[test]
    fn production_relay_timeouts_are_the_frozen_pair() {
        assert_eq!(
            datalink::RelayTimeouts::PRODUCTION,
            datalink::RelayTimeouts {
                default: datalink::REQUEST_TIMEOUT,
                prefile: datalink::PREFILE_REQUEST_TIMEOUT,
                sayintentions: datalink::SAYINTENTIONS_REQUEST_TIMEOUT,
            }
        );
        assert!(SCALED.prefile > SCALED.default);
    }

    #[test]
    fn a_prefile_answered_after_the_default_timeout_still_resolves_with_that_answer() {
        let fixture = Fixture::new("slow-prefile");
        let backend = fixture.backend();
        let statuses = fixture.count("status");
        let (envelope, elapsed) = fixture.timed("watch", json!({"on":true}));
        assert_eq!(envelope, json!({"ok":true, "result":{"echo":"watch"}}));
        assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");

        let (envelope, elapsed) = fixture.timed("simbrief-prefile", json!({}));
        assert_eq!(
            envelope,
            json!({"ok":true, "result":{"echo":"simbrief-prefile"}})
        );
        assert!(elapsed >= Duration::from_millis(1_500), "{elapsed:?}");
        assert!(elapsed > SCALED.default, "{elapsed:?}");
        assert!(elapsed < SCALED.prefile, "{elapsed:?}");
        assert_eq!(fixture.ops(), ["watch", "simbrief-prefile"]);

        // Settings and clear are answered at once and wait only the default.
        for op in ["simbrief-settings", "prefile-clear"] {
            let (envelope, elapsed) = fixture.timed(op, json!({}));
            assert_eq!(envelope, json!({"ok":true, "result":{"echo":op}}));
            assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
        }
        // Extra keys never reach the sidecar.
        for (op, params) in [
            ("simbrief-prefile", duplicate_override()),
            ("simbrief-prefile", json!({"tripId":1})),
            ("simbrief-settings", json!({"pilotId":"1"})),
            ("prefile-clear", json!({"plannedLegId":123})),
            ("simbrief-prefile", json!(null)),
        ] {
            let (envelope, elapsed) = fixture.timed(op, params);
            assert_eq!(code(&envelope), "bad-request");
            assert!(elapsed < Duration::from_secs(1));
        }
        assert_eq!(
            fixture.ops(),
            [
                "watch",
                "simbrief-prefile",
                "simbrief-settings",
                "prefile-clear"
            ]
        );
        assert!(!fixture.supervisor.prefile_in_flight.load(Ordering::Acquire));
        assert_eq!(fixture.backend(), backend);
        assert_eq!(fixture.count("status"), statuses);
    }

    #[test]
    fn an_unanswered_prefile_times_out_at_its_own_deadline_and_is_single_flight() {
        let fixture = Fixture::new("ignore");
        let backend = fixture.backend();
        let statuses = fixture.count("status");
        let first = fixture.spawn_prefile();
        fixture.wait(|| fixture.prefile_lines() == 1, 5);

        let (envelope, elapsed) = fixture.timed("simbrief-prefile", json!({}));
        assert_eq!(code(&envelope), "prefile-in-progress");
        assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
        assert_eq!(fixture.prefile_lines(), 1);

        // Every other op still waits only the default deadline.
        let (envelope, elapsed) = fixture.timed("watch", json!({"on":true}));
        assert_eq!(code(&envelope), "shell-timeout");
        assert!(elapsed >= SCALED.default, "{elapsed:?}");
        assert!(elapsed < Duration::from_secs(2), "{elapsed:?}");

        let (envelope, elapsed) = first.join().unwrap();
        assert_eq!(code(&envelope), "shell-timeout");
        assert!(elapsed >= SCALED.prefile, "{elapsed:?}");
        assert!(elapsed < Duration::from_millis(3_500), "{elapsed:?}");
        assert!(!fixture.supervisor.prefile_in_flight.load(Ordering::Acquire));
        assert_eq!(fixture.supervisor.relay.pending(), 0);

        thread::sleep(Duration::from_secs(1));
        assert_eq!(fixture.prefile_lines(), 1);
        assert_eq!(fixture.backend(), backend);
        assert_eq!(fixture.count("status"), statuses);
    }

    #[test]
    fn a_prefile_is_never_resent_after_the_sidecar_exits() {
        let fixture = Fixture::new("exit-on-request");
        let (envelope, elapsed) = fixture.timed("simbrief-prefile", json!({}));
        assert_eq!(code(&envelope), "sidecar-exited");
        assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
        assert!(!fixture.supervisor.prefile_in_flight.load(Ordering::Acquire));
        fixture.wait(|| fixture.starts() == 2, 10);
        fixture.wait(|| lock(&fixture.supervisor.snapshot).hello.is_some(), 5);
        thread::sleep(Duration::from_secs(1));
        assert_eq!(fixture.ops(), ["simbrief-prefile"]);
    }

    #[test]
    fn a_prefile_is_never_resent_after_a_restart() {
        let fixture = Fixture::new("ignore");
        let waiter = fixture.spawn_prefile();
        fixture.wait(|| fixture.prefile_lines() == 1, 5);
        fixture.supervisor.request(Operation::Restart).unwrap();
        let (envelope, elapsed) = waiter.join().unwrap();
        assert_eq!(code(&envelope), "sidecar-exited");
        assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
        fixture.wait(|| fixture.starts() == 2, 10);
        thread::sleep(Duration::from_secs(1));
        assert_eq!(fixture.ops(), ["simbrief-prefile"]);
        assert!(!fixture.supervisor.prefile_in_flight.load(Ordering::Acquire));
    }

    #[test]
    fn a_sidecar_without_simbrief_is_refused_at_once_and_keeps_its_datalink() {
        let fixture = Fixture::new("no-simbrief");
        let backend = fixture.backend();
        let statuses = fixture.count("status");
        let events = fixture.count("datalink");
        let state = fixture.supervisor.current_datalink_state();
        for op in ["simbrief-settings", "simbrief-prefile", "prefile-clear"] {
            let (envelope, elapsed) = fixture.timed(op, json!({}));
            assert_eq!(
                envelope,
                json!({"ok":false, "error":{"code":"sidecar-outdated", "httpStatus":null, "serverCode":null}})
            );
            assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
        }
        // Gated before params: even a malformed request is simply outdated.
        let (envelope, _) = fixture.timed("simbrief-prefile", duplicate_override());
        assert_eq!(code(&envelope), "sidecar-outdated");
        thread::sleep(Duration::from_millis(300));
        assert_eq!(fixture.ops(), Vec::<String>::new());
        assert_eq!(fixture.count("datalink"), events);
        assert_eq!(fixture.supervisor.current_datalink_state(), state);
        assert!(!fixture.supervisor.prefile_in_flight.load(Ordering::Acquire));

        let (envelope, _) = fixture.timed("watch", json!({"on":true}));
        assert_eq!(envelope, json!({"ok":true, "result":{"echo":"watch"}}));
        assert_eq!(fixture.ops(), ["watch"]);
        assert_eq!(fixture.backend(), backend);
        assert_eq!(fixture.count("status"), statuses);
    }

    #[test]
    fn the_ingest_token_never_leaves_the_shell_on_the_simbrief_ops() {
        let fixture = Fixture::new("echo-token");
        let backend = fixture.backend();
        let mut envelopes = Vec::new();
        for op in ["simbrief-settings", "simbrief-prefile", "prefile-clear"] {
            let (envelope, _) = fixture.timed(op, json!({}));
            assert_eq!(envelope["ok"], true, "{op}");
            assert_eq!(envelope["result"]["note"], "token [REDACTED]");
            envelopes.push(envelope.to_string());
        }
        fixture.wait(|| fixture.count("datalink") >= 4, 5);
        let state = fixture.supervisor.current_datalink_state();
        let events = serde_json::to_string(&*lock(&fixture.events)).unwrap();
        let logs = serde_json::to_string(&lock(&fixture.supervisor.snapshot).logs).unwrap();
        for output in envelopes
            .into_iter()
            .chain([state.to_string(), events, logs])
        {
            assert!(!output.contains(SENTINEL));
        }
        assert_eq!(fixture.backend(), backend);
    }
}

// The clearance op through the relay, against the Python fixture, with the
// relay deadline scaled down so nothing waits the production 12 s.
#[cfg(test)]
mod clearance_process_tests {
    use super::*;
    use std::{fs, sync::atomic::AtomicUsize};

    const SENTINEL: &str = "SENTINEL-CLEARANCE-TOKEN-0000";
    const SCALED: datalink::RelayTimeouts = datalink::RelayTimeouts {
        default: Duration::from_millis(1_000),
        prefile: Duration::from_millis(2_500),
        sayintentions: Duration::from_millis(2_000),
    };
    static SEQUENCE: AtomicUsize = AtomicUsize::new(0);

    fn python_path() -> &'static str {
        if cfg!(windows) {
            "python"
        } else {
            "/usr/bin/python3"
        }
    }

    struct Fixture {
        root: PathBuf,
        supervisor: Supervisor,
        events: Arc<Mutex<Vec<(&'static str, Value)>>>,
    }

    impl Fixture {
        fn new(mode: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "msfslogger-clearance-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::SeqCst)
            ));
            fs::create_dir_all(root.join("dist")).unwrap();
            let entry = root.join("dist").join("index.js");
            fs::write(&entry, include_str!("../tests/fake-sidecar.py")).unwrap();
            let config = ConfigStore::new(root.join("config.json"));
            config
                .save(
                    json!({"nodePath":python_path(), "autoUplink":false, "datalinkMode":mode,
                    "serverUrl":"http://127.0.0.1:1", "ingestToken":SENTINEL}),
                )
                .unwrap();
            let events = Arc::new(Mutex::new(Vec::new()));
            let captured = events.clone();
            let sink = Arc::new(move |event| {
                let recorded = match event {
                    Event::Status(v) => ("status", v),
                    Event::Log(v) => ("log", v),
                    Event::Exit(v) => ("exit", v),
                    Event::Datalink(v) => ("datalink", v),
                };
                lock(&captured).push(recorded);
            });
            let supervisor = Supervisor::new(config, Some(entry), sink)
                .unwrap()
                .with_relay_timeouts(SCALED);
            let fixture = Self {
                root,
                supervisor,
                events,
            };
            fixture.wait(|| fixture.app_state() == "app.stopped", 10);
            fixture.wait(|| fixture.count("datalink") >= 1, 5);
            fixture
        }

        fn wait(&self, predicate: impl Fn() -> bool, seconds: u64) {
            let deadline = Instant::now() + Duration::from_secs(seconds);
            while !predicate() {
                assert!(
                    Instant::now() < deadline,
                    "Timed out waiting for fixture state"
                );
                thread::sleep(Duration::from_millis(20));
            }
        }

        fn app_state(&self) -> String {
            lock(&self.supervisor.snapshot).status.as_ref().unwrap()["app"]["state"]
                .as_str()
                .unwrap()
                .to_owned()
        }

        fn backend(&self) -> Value {
            lock(&self.supervisor.snapshot).status.as_ref().unwrap()["backend"].clone()
        }

        fn count(&self, kind: &str) -> usize {
            lock(&self.events)
                .iter()
                .filter(|(k, _)| *k == kind)
                .count()
        }

        fn starts(&self) -> usize {
            fs::read_to_string(self.root.join("starts"))
                .unwrap_or_default()
                .lines()
                .count()
        }

        /// Every op the fixture received, one per request line, in order.
        fn ops(&self) -> Vec<String> {
            fs::read_to_string(self.root.join("datalink-ops"))
                .unwrap_or_default()
                .lines()
                .map(str::to_owned)
                .collect()
        }

        fn clearance_lines(&self) -> usize {
            self.ops().iter().filter(|op| *op == "clearance").count()
        }

        fn in_flight(&self) -> bool {
            self.supervisor.clearance_in_flight.load(Ordering::Acquire)
        }

        fn timed(&self, op: &str, params: Value) -> (Value, Duration) {
            let started = Instant::now();
            let envelope = self.supervisor.datalink(op, params);
            (envelope, started.elapsed())
        }

        fn spawn_clearance(&self) -> thread::JoinHandle<(Value, Duration)> {
            let supervisor = self.supervisor.clone();
            thread::spawn(move || {
                let started = Instant::now();
                (
                    supervisor.datalink("clearance", json!({"plannedLegId":12})),
                    started.elapsed(),
                )
            })
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.supervisor.shutdown();
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn code(envelope: &Value) -> &str {
        envelope["error"]["code"].as_str().unwrap_or_default()
    }

    #[test]
    fn one_clearance_writes_one_line_and_waits_only_the_default_deadline() {
        let fixture = Fixture::new("answer");
        let backend = fixture.backend();
        let statuses = fixture.count("status");
        let (envelope, elapsed) = fixture.timed("clearance", json!({"plannedLegId":12}));
        assert_eq!(envelope, json!({"ok":true, "result":{"echo":"clearance"}}));
        assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
        assert_eq!(fixture.ops(), ["clearance"]);
        assert!(!fixture.in_flight());
        assert_eq!(
            fixture.supervisor.relay_timeouts.for_op("clearance"),
            SCALED.default
        );

        // Params out of contract never reach the sidecar.
        for params in [
            json!({"plannedLegId":12, "tripId":1}),
            json!({"plannedLegId":12, "flightId":92}),
            json!({"plannedLegId":0}),
            json!({"plannedLegId":"12"}),
            json!({"plannedLegId":12.5}),
            json!({"plannedLegId":9_007_199_254_740_992_u64}),
            json!({}),
            json!(null),
        ] {
            let (envelope, elapsed) = fixture.timed("clearance", params);
            assert_eq!(code(&envelope), "bad-request");
            assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
        }
        thread::sleep(Duration::from_millis(300));
        assert_eq!(fixture.ops(), ["clearance"]);
        assert!(!fixture.in_flight());
        assert_eq!(fixture.backend(), backend);
        assert_eq!(fixture.count("status"), statuses);
    }

    #[test]
    fn an_unanswered_clearance_times_out_is_single_flight_and_is_never_resent() {
        let fixture = Fixture::new("ignore");
        let backend = fixture.backend();
        let statuses = fixture.count("status");
        let first = fixture.spawn_clearance();
        fixture.wait(|| fixture.clearance_lines() == 1, 5);

        let (envelope, elapsed) = fixture.timed("clearance", json!({"plannedLegId":12}));
        assert_eq!(
            envelope,
            json!({"ok":false, "error":{"code":"clearance-in-progress", "httpStatus":null, "serverCode":null}})
        );
        assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
        assert_eq!(fixture.clearance_lines(), 1);
        // Nothing was registered for the refused press.
        assert_eq!(fixture.supervisor.relay.pending(), 1);

        let (envelope, elapsed) = first.join().unwrap();
        assert_eq!(code(&envelope), "shell-timeout");
        assert!(elapsed >= SCALED.default, "{elapsed:?}");
        assert!(elapsed < Duration::from_secs(2), "{elapsed:?}");
        assert!(!fixture.in_flight());
        assert_eq!(fixture.supervisor.relay.pending(), 0);

        thread::sleep(Duration::from_secs(1));
        assert_eq!(fixture.clearance_lines(), 1);

        // Once settled, a new press is accepted and writes its own line.
        let (envelope, _) = fixture.timed("clearance", json!({"plannedLegId":12}));
        assert_eq!(code(&envelope), "shell-timeout");
        assert_eq!(fixture.clearance_lines(), 2);
        assert!(!fixture.in_flight());
        assert_eq!(fixture.backend(), backend);
        assert_eq!(fixture.count("status"), statuses);
    }

    #[test]
    fn a_clearance_is_never_resent_after_the_sidecar_exits() {
        let fixture = Fixture::new("exit-on-request");
        let (envelope, elapsed) = fixture.timed("clearance", json!({"plannedLegId":12}));
        assert_eq!(code(&envelope), "sidecar-exited");
        assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
        assert!(!fixture.in_flight());
        fixture.wait(|| fixture.starts() == 2, 10);
        fixture.wait(|| lock(&fixture.supervisor.snapshot).hello.is_some(), 5);
        thread::sleep(Duration::from_secs(1));
        assert_eq!(fixture.ops(), ["clearance"]);
    }

    #[test]
    fn a_clearance_is_never_resent_after_a_restart() {
        let fixture = Fixture::new("ignore");
        let waiter = fixture.spawn_clearance();
        fixture.wait(|| fixture.clearance_lines() == 1, 5);
        fixture.supervisor.request(Operation::Restart).unwrap();
        let (envelope, elapsed) = waiter.join().unwrap();
        assert_eq!(code(&envelope), "sidecar-exited");
        assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
        fixture.wait(|| fixture.starts() == 2, 10);
        thread::sleep(Duration::from_secs(1));
        assert_eq!(fixture.ops(), ["clearance"]);
        assert!(!fixture.in_flight());
    }

    #[test]
    fn a_sidecar_without_the_clearance_feature_is_refused_at_once_and_keeps_the_rest() {
        for mode in ["no-clearance", "no-simbrief"] {
            let fixture = Fixture::new(mode);
            let backend = fixture.backend();
            let statuses = fixture.count("status");
            let events = fixture.count("datalink");
            let state = fixture.supervisor.current_datalink_state();
            let (envelope, elapsed) = fixture.timed("clearance", json!({"plannedLegId":12}));
            assert_eq!(
                envelope,
                json!({"ok":false, "error":{"code":"sidecar-outdated", "httpStatus":null, "serverCode":null}}),
                "{mode}"
            );
            assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
            // Gated before params: even a malformed request is simply outdated.
            let (envelope, _) = fixture.timed("clearance", json!({"tripId":1}));
            assert_eq!(code(&envelope), "sidecar-outdated");
            thread::sleep(Duration::from_millis(300));
            assert_eq!(fixture.ops(), Vec::<String>::new(), "{mode}");
            assert_eq!(fixture.count("datalink"), events);
            assert_eq!(fixture.supervisor.current_datalink_state(), state);
            assert!(!fixture.in_flight());

            let (envelope, _) = fixture.timed("watch", json!({"on":true}));
            assert_eq!(envelope, json!({"ok":true, "result":{"echo":"watch"}}));
            assert_eq!(fixture.ops(), ["watch"]);
            assert_eq!(fixture.backend(), backend);
            assert_eq!(fixture.count("status"), statuses);
        }
        let fixture = Fixture::new("no-clearance");
        let (envelope, _) = fixture.timed("simbrief-settings", json!({}));
        assert_eq!(
            envelope,
            json!({"ok":true, "result":{"echo":"simbrief-settings"}})
        );
    }

    #[test]
    fn the_ingest_token_never_leaves_the_shell_on_the_clearance_op() {
        let fixture = Fixture::new("echo-token");
        let backend = fixture.backend();
        let statuses = fixture.count("status");
        let (envelope, _) = fixture.timed("clearance", json!({"plannedLegId":12}));
        assert_eq!(envelope["ok"], true);
        assert_eq!(envelope["result"]["note"], "token [REDACTED]");
        fixture.wait(|| fixture.count("datalink") >= 2, 5);
        let state = fixture.supervisor.current_datalink_state();
        let events = serde_json::to_string(&*lock(&fixture.events)).unwrap();
        let logs = serde_json::to_string(&lock(&fixture.supervisor.snapshot).logs).unwrap();
        for output in [envelope.to_string(), state.to_string(), events, logs] {
            assert!(!output.contains(SENTINEL));
        }
        assert_eq!(fixture.backend(), backend);
        assert_eq!(fixture.count("status"), statuses);
    }
}

// The five SayIntentions ops through the relay, against the Python fixture,
// with the relay deadlines scaled down so nothing waits the production 12 s
// or 25 s.
#[cfg(test)]
mod sayintentions_process_tests {
    use super::*;
    use std::{fs, sync::atomic::AtomicUsize};

    const SENTINEL: &str = "SENTINEL-SAYINTENTIONS-TOKEN0";
    const SCALED: datalink::RelayTimeouts = datalink::RelayTimeouts {
        default: Duration::from_millis(1_000),
        prefile: Duration::from_millis(3_000),
        sayintentions: Duration::from_millis(2_000),
    };
    /// The accepted shape of each op, in the order the contract lists them.
    const ACCEPTED: [(&str, &str); 5] = [
        ("si-status", r#"{"flightId":92}"#),
        ("si-link", r#"{"flightId":92,"from":"now"}"#),
        ("si-unlink", r#"{"flightId":92}"#),
        ("si-import", r#"{"flightId":92}"#),
        ("si-pdc", r#"{"plannedLegId":12}"#),
    ];
    static SEQUENCE: AtomicUsize = AtomicUsize::new(0);

    fn python_path() -> &'static str {
        if cfg!(windows) {
            "python"
        } else {
            "/usr/bin/python3"
        }
    }

    struct Fixture {
        root: PathBuf,
        supervisor: Supervisor,
        events: Arc<Mutex<Vec<(&'static str, Value)>>>,
    }

    impl Fixture {
        fn new(mode: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "msfslogger-sayintentions-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::SeqCst)
            ));
            fs::create_dir_all(root.join("dist")).unwrap();
            let entry = root.join("dist").join("index.js");
            fs::write(&entry, include_str!("../tests/fake-sidecar.py")).unwrap();
            let config = ConfigStore::new(root.join("config.json"));
            config
                .save(
                    json!({"nodePath":python_path(), "autoUplink":false, "datalinkMode":mode,
                    "serverUrl":"http://127.0.0.1:1", "ingestToken":SENTINEL}),
                )
                .unwrap();
            let events = Arc::new(Mutex::new(Vec::new()));
            let captured = events.clone();
            let sink = Arc::new(move |event| {
                let recorded = match event {
                    Event::Status(v) => ("status", v),
                    Event::Log(v) => ("log", v),
                    Event::Exit(v) => ("exit", v),
                    Event::Datalink(v) => ("datalink", v),
                };
                lock(&captured).push(recorded);
            });
            let supervisor = Supervisor::new(config, Some(entry), sink)
                .unwrap()
                .with_relay_timeouts(SCALED);
            let fixture = Self {
                root,
                supervisor,
                events,
            };
            fixture.wait(|| fixture.app_state() == "app.stopped", 10);
            fixture.wait(|| fixture.count("datalink") >= 1, 5);
            fixture
        }

        fn wait(&self, predicate: impl Fn() -> bool, seconds: u64) {
            let deadline = Instant::now() + Duration::from_secs(seconds);
            while !predicate() {
                assert!(
                    Instant::now() < deadline,
                    "Timed out waiting for fixture state"
                );
                thread::sleep(Duration::from_millis(20));
            }
        }

        fn app_state(&self) -> String {
            lock(&self.supervisor.snapshot).status.as_ref().unwrap()["app"]["state"]
                .as_str()
                .unwrap()
                .to_owned()
        }

        fn backend(&self) -> Value {
            lock(&self.supervisor.snapshot).status.as_ref().unwrap()["backend"].clone()
        }

        fn count(&self, kind: &str) -> usize {
            lock(&self.events)
                .iter()
                .filter(|(k, _)| *k == kind)
                .count()
        }

        /// Every op the fixture received, one per request line, in order.
        fn ops(&self) -> Vec<String> {
            fs::read_to_string(self.root.join("datalink-ops"))
                .unwrap_or_default()
                .lines()
                .map(str::to_owned)
                .collect()
        }

        fn in_flight(&self) -> bool {
            self.supervisor
                .sayintentions_in_flight
                .load(Ordering::Acquire)
        }

        fn timed(&self, op: &str, params: Value) -> (Value, Duration) {
            let started = Instant::now();
            let envelope = self.supervisor.datalink(op, params);
            (envelope, started.elapsed())
        }

        fn spawn(&self, op: &'static str, params: Value) -> thread::JoinHandle<(Value, Duration)> {
            let supervisor = self.supervisor.clone();
            thread::spawn(move || {
                let started = Instant::now();
                (supervisor.datalink(op, params), started.elapsed())
            })
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.supervisor.shutdown();
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn code(envelope: &Value) -> &str {
        envelope["error"]["code"].as_str().unwrap_or_default()
    }

    fn params(shape: &str) -> Value {
        serde_json::from_str(shape).unwrap()
    }

    #[test]
    fn production_relay_timeouts_carry_the_sayintentions_pair() {
        assert_eq!(
            datalink::RelayTimeouts::PRODUCTION.sayintentions,
            datalink::SAYINTENTIONS_REQUEST_TIMEOUT
        );
        assert!(SCALED.sayintentions > SCALED.default);
    }

    #[test]
    fn each_op_relays_one_line_and_params_out_of_contract_never_reach_the_sidecar() {
        let fixture = Fixture::new("answer");
        let backend = fixture.backend();
        let statuses = fixture.count("status");
        for (op, shape) in ACCEPTED {
            let (envelope, elapsed) = fixture.timed(op, params(shape));
            assert_eq!(envelope, json!({"ok":true, "result":{"echo":op}}), "{op}");
            assert!(elapsed < Duration::from_secs(1), "{op} {elapsed:?}");
            assert!(!fixture.in_flight(), "{op}");
        }
        // The flight-free question is the same op with a null id.
        let (envelope, _) = fixture.timed("si-status", json!({"flightId":null}));
        assert_eq!(envelope, json!({"ok":true, "result":{"echo":"si-status"}}));
        let relayed = fixture.ops();
        assert_eq!(
            relayed,
            [
                "si-status",
                "si-link",
                "si-unlink",
                "si-import",
                "si-pdc",
                "si-status"
            ]
        );
        // Refused before the relay is entered: the fixture is reading stdin, so
        // an unchanged op list means no line was written for any of these.
        for (op, shape) in [
            ("si-status", r#"{}"#),
            ("si-status", r#"{"flightId":92,"plannedLegId":12}"#),
            ("si-status", r#"{"flightId":"92"}"#),
            ("si-status", r#"{"flightId":0}"#),
            ("si-status", r#"{"flightId":1.5}"#),
            ("si-link", r#"{"flightId":92}"#),
            ("si-link", r#"{"flightId":92,"from":"session_start"}"#),
            ("si-link", r#"{"flightId":92,"from":"now","sinceId":1}"#),
            ("si-unlink", r#"{"flightId":null}"#),
            ("si-import", r#"{"flightId":92,"sinceId":1}"#),
            ("si-pdc", r#"{"flightId":92}"#),
            ("si-pdc", r#"null"#),
        ] {
            let (envelope, elapsed) = fixture.timed(op, params(shape));
            assert_eq!(code(&envelope), "bad-request", "{op} {shape}");
            assert!(elapsed < Duration::from_secs(1), "{op} {shape}");
        }
        thread::sleep(Duration::from_millis(300));
        assert_eq!(fixture.ops(), relayed);
        assert!(!fixture.in_flight());
        assert_eq!(fixture.supervisor.relay.pending(), 0);
        assert_eq!(fixture.backend(), backend);
        assert_eq!(fixture.count("status"), statuses);
    }

    #[test]
    fn an_unanswered_write_waits_its_own_deadline_and_one_guard_covers_all_four() {
        let fixture = Fixture::new("ignore");
        let backend = fixture.backend();
        let first = fixture.spawn("si-import", json!({"flightId":92}));
        fixture.wait(|| fixture.ops() == ["si-import"], 5);

        // Any other write, on any page, is refused while that one is open.
        for (op, shape) in [
            ("si-link", r#"{"flightId":92,"from":"now"}"#),
            ("si-unlink", r#"{"flightId":92}"#),
            ("si-import", r#"{"flightId":92}"#),
            ("si-pdc", r#"{"plannedLegId":12}"#),
        ] {
            let (envelope, elapsed) = fixture.timed(op, params(shape));
            assert_eq!(
                envelope,
                json!({"ok":false, "error":{"code":"sayintentions-in-progress", "httpStatus":null, "serverCode":null}}),
                "{op}"
            );
            assert!(elapsed < Duration::from_secs(1), "{op} {elapsed:?}");
        }
        // The read takes no guard and waits only the default deadline.
        let (envelope, elapsed) = fixture.timed("si-status", json!({"flightId":92}));
        assert_eq!(code(&envelope), "shell-timeout");
        assert!(elapsed >= SCALED.default, "{elapsed:?}");
        assert!(elapsed < SCALED.sayintentions, "{elapsed:?}");

        let (envelope, elapsed) = first.join().unwrap();
        assert_eq!(code(&envelope), "shell-timeout");
        assert!(elapsed >= SCALED.sayintentions, "{elapsed:?}");
        assert!(elapsed < Duration::from_millis(3_000), "{elapsed:?}");
        assert!(!fixture.in_flight());
        assert_eq!(fixture.supervisor.relay.pending(), 0);
        assert_eq!(fixture.ops(), ["si-import", "si-status"]);

        // Once settled, the next press is accepted and writes its own line.
        let (envelope, _) = fixture.timed("si-pdc", json!({"plannedLegId":12}));
        assert_eq!(code(&envelope), "shell-timeout");
        assert_eq!(fixture.ops(), ["si-import", "si-status", "si-pdc"]);
        assert!(!fixture.in_flight());
        assert_eq!(fixture.backend(), backend);
    }

    #[test]
    fn a_sidecar_without_sayintentions_is_refused_at_once_and_keeps_the_rest() {
        let fixture = Fixture::new("no-sayintentions");
        let backend = fixture.backend();
        let statuses = fixture.count("status");
        let events = fixture.count("datalink");
        let state = fixture.supervisor.current_datalink_state();
        for (op, shape) in ACCEPTED {
            let (envelope, elapsed) = fixture.timed(op, params(shape));
            assert_eq!(
                envelope,
                json!({"ok":false, "error":{"code":"sidecar-outdated", "httpStatus":null, "serverCode":null}}),
                "{op}"
            );
            assert!(elapsed < Duration::from_secs(1), "{op} {elapsed:?}");
        }
        // Gated before params: a malformed request reads as outdated, because
        // the feature is missing whatever the params say.
        for (op, shape) in [
            ("si-status", r#"{}"#),
            ("si-link", r#"{"flightId":0,"from":"whenever"}"#),
            ("si-pdc", r#"{"flightId":92}"#),
        ] {
            let (envelope, _) = fixture.timed(op, params(shape));
            assert_eq!(code(&envelope), "sidecar-outdated", "{op} {shape}");
        }
        thread::sleep(Duration::from_millis(300));
        assert_eq!(fixture.ops(), Vec::<String>::new());
        assert_eq!(fixture.count("datalink"), events);
        assert_eq!(fixture.supervisor.current_datalink_state(), state);
        assert!(!fixture.in_flight());

        // Everything the sidecar does announce still works.
        for (op, shape) in [
            ("watch", r#"{"on":true}"#),
            ("clearance", r#"{"plannedLegId":12}"#),
        ] {
            let (envelope, _) = fixture.timed(op, params(shape));
            assert_eq!(envelope, json!({"ok":true, "result":{"echo":op}}), "{op}");
        }
        assert_eq!(fixture.ops(), ["watch", "clearance"]);
        assert_eq!(fixture.backend(), backend);
        assert_eq!(fixture.count("status"), statuses);
    }

    #[test]
    fn the_ingest_token_never_leaves_the_shell_on_the_sayintentions_ops() {
        let fixture = Fixture::new("echo-token");
        let backend = fixture.backend();
        let mut envelopes = Vec::new();
        for (op, shape) in ACCEPTED {
            let (envelope, _) = fixture.timed(op, params(shape));
            assert_eq!(envelope["ok"], true, "{op}");
            assert_eq!(envelope["result"]["note"], "token [REDACTED]", "{op}");
            envelopes.push(envelope.to_string());
        }
        fixture.wait(|| fixture.count("datalink") >= 6, 5);
        let state = fixture.supervisor.current_datalink_state();
        let events = serde_json::to_string(&*lock(&fixture.events)).unwrap();
        let logs = serde_json::to_string(&lock(&fixture.supervisor.snapshot).logs).unwrap();
        for output in envelopes
            .into_iter()
            .chain([state.to_string(), events, logs])
        {
            assert!(!output.contains(SENTINEL));
        }
        assert_eq!(fixture.backend(), backend);
    }
}

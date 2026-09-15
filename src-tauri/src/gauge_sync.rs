use crate::{
    config::ConfigStore,
    supervisor::{Event, Operation, Supervisor},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use pbkdf2::pbkdf2_hmac;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs, io,
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc, Arc, Mutex, Weak,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tungstenite::{
    accept_hdr_with_config,
    handshake::server::{Request, Response},
    http::{Response as HttpResponse, StatusCode},
    protocol::WebSocketConfig,
    Message,
};
use url::Url;

pub const MAX_CLIENTS: usize = 4;
pub const MAX_HTTP_HEADER_BYTES: usize = 8192;
pub const MAX_WS_MESSAGE_BYTES: usize = 32768;
pub const MAX_REQUESTS_PER_10S: usize = 20;
pub const MAX_COMMANDS_PER_10S: usize = 6;
pub const MAX_PAIR_ATTEMPTS_PER_60S: usize = 5;
pub const MAX_INBOUND_IN_FLIGHT: usize = 1;
pub const MAX_OUTBOUND_QUEUE: usize = 64;
pub const MAX_LOG_MESSAGE_BYTES: usize = 2048;
pub const MAX_ERROR_MESSAGE_BYTES: usize = 256;
pub const MAX_JSON_DEPTH: usize = 16;
pub const MAX_OBJECT_KEYS: usize = 64;
pub const MAX_ARRAY_ITEMS: usize = 128;
pub const MAX_STRING_BYTES: usize = 4096;
pub const MAX_REQUEST_ID_BYTES: usize = 64;
pub const MAX_DEDUP_ENTRIES: usize = 1024;
pub const MAX_DEDUP_AGE_MS: u64 = 600_000;
pub const MAX_PAIR_CODE_AGE_MS: u64 = 120_000;
pub const MAX_AUTH_DEADLINE_MS: u64 = 5_000;
pub const MAX_IDLE_MS: u64 = 30_000;
pub const MAX_PONG_WAIT_MS: u64 = 10_000;
pub const MAX_COMMAND_RESULT_WAIT_MS: u64 = 5_000;
pub const MAX_CONFIG_RESULT_WAIT_MS: u64 = 10_000;
pub const PRODUCTION_PORT: u16 = 39091;
pub const PATH: &str = "/gauge-sync/v1";
static NEXT_SOCKET_ID: AtomicU64 = AtomicU64::new(1);
#[cfg(test)]
static TEST_SERVER_STAGE: AtomicUsize = AtomicUsize::new(0);
#[cfg(test)]
static TEST_FIRST_READ_OUTCOME: AtomicUsize = AtomicUsize::new(0);
#[cfg(test)]
static TEST_PEEK_AVAILABLE: AtomicUsize = AtomicUsize::new(0);
#[cfg(test)]
static TEST_PEEK_META: Mutex<Option<(bool, u8, bool, u8, u64)>> = Mutex::new(None);
#[cfg(test)]
fn test_stage(value: usize) {
    TEST_SERVER_STAGE.fetch_max(value, Ordering::AcqRel);
}
#[cfg(test)]
fn test_stage_name() -> &'static str {
    match TEST_SERVER_STAGE.load(Ordering::Acquire) {
        1 => "UPGRADE_ACCEPTED",
        2 => "FIRST_FRAME_READ",
        3 => "FIRST_SCHEMA_VALID",
        4 => "CAPABILITY_AUTHORIZED",
        5 => "AUTH_RESPONSE_SENT",
        6 => "WRITER_STARTED",
        7 => "WELCOME_QUEUED",
        8 => "FULL_QUEUED",
        _ => "NOT_STARTED",
    }
}
#[cfg(test)]
fn test_first_read_outcome_name() -> &'static str {
    match TEST_FIRST_READ_OUTCOME.load(Ordering::Acquire) {
        1 => "TEXT",
        2 => "BINARY",
        3 => "TIMEOUT",
        4 => "CONNECTION_CLOSED",
        5 => "PROTOCOL_ERROR",
        6 => "CAPACITY_ERROR",
        7 => "OTHER_ERROR",
        _ => "NONE",
    }
}
#[cfg(all(test, windows))]
fn test_peek_frame(stream: &std::net::TcpStream, deadline: Instant) {
    use std::os::windows::io::AsRawSocket;
    #[link(name = "ws2_32")]
    unsafe extern "system" {
        fn ioctlsocket(socket: usize, command: i32, value: *mut u32) -> i32;
        fn recv(socket: usize, buffer: *mut u8, length: i32, flags: i32) -> i32;
    }
    let socket = stream.as_raw_socket() as usize;
    let mut available = 0u32;
    while Instant::now() < deadline {
        if unsafe { ioctlsocket(socket, 0x4004667f_u32 as i32, &mut available) } == 0
            && available != 0
        {
            break;
        }
        thread::sleep(Duration::from_millis(1));
    }
    TEST_PEEK_AVAILABLE.store(available as usize, Ordering::Release);
    if available < 2 {
        return;
    }
    let mut header = [0u8; 10];
    let count = unsafe { recv(socket, header.as_mut_ptr(), header.len() as i32, 0x2) };
    if count < 2 {
        return;
    }
    let marker = header[1] & 0x7f;
    let declared = if marker < 126 {
        marker as u64
    } else if marker == 126 && count >= 4 {
        u16::from_be_bytes([header[2], header[3]]) as u64
    } else if marker == 127 && count >= 10 {
        u64::from_be_bytes(header[2..10].try_into().unwrap())
    } else {
        u64::MAX
    };
    *TEST_PEEK_META.lock().unwrap() = Some((
        header[0] & 0x80 != 0,
        header[0] & 0x0f,
        header[1] & 0x80 != 0,
        marker,
        declared,
    ));
}

// MSFS 2020 Coherent GT serves html_ui content from `coui://html_ui`, which has no port
// (observed 2026-09-15, see .claude/runs/2026-09-14-tauri-gauge-sync/origin-gate-msfs2020.md).
// Every add-on shares this origin, so pairing, not origin, authenticates the gauge.
pub const ALLOWED_GAUGE_ORIGINS: &[(&str, &str, Option<u16>)] = &[("coui", "html_ui", None)];

pub fn normalize_confirm_corrupt(value: Option<bool>) -> bool {
    value.unwrap_or(false)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OriginTuple {
    pub scheme: String,
    pub host: String,
    pub port: Option<u16>,
}

pub fn parse_origin(raw: &str) -> Option<OriginTuple> {
    if raw == "null" || raw == "*" {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    let port = url.port_or_known_default();
    Some(OriginTuple {
        scheme: url.scheme().to_ascii_lowercase(),
        host,
        port,
    })
}

pub fn origin_allowed(raw: &str, allowed: &[(&str, &str, Option<u16>)]) -> bool {
    parse_origin(raw).is_some_and(|o| {
        allowed
            .iter()
            .any(|a| o.scheme == a.0 && o.host == a.1 && o.port == a.2)
    })
}

pub fn validate_upgrade(
    peer: SocketAddr,
    target: &str,
    hosts: &[&str],
    origins: &[&str],
    forwarded: bool,
    port: u16,
    allowed: &[(&str, &str, Option<u16>)],
) -> u16 {
    if target != PATH {
        return 404;
    }
    if !matches!(peer.ip(), IpAddr::V4(ip) if ip.is_loopback()) || forwarded {
        return 403;
    }
    let expected = format!("127.0.0.1:{port}");
    if hosts.len() != 1
        || hosts[0] != expected
        || origins.len() != 1
        || !origin_allowed(origins[0], allowed)
    {
        return 403;
    }
    101
}

pub fn bind_loopback(port: u16) -> std::io::Result<TcpListener> {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port))
}

#[cfg(test)]
#[derive(Default)]
pub struct OutboundQueue {
    frames: VecDeque<Arc<[u8]>>,
    reserved: usize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WriterKind {
    Response,
    Status,
    Log,
    Exit,
    Control,
}
struct WriterItem {
    kind: WriterKind,
    message: Message,
}
#[derive(Default)]
struct WriterState {
    queue: VecDeque<WriterItem>,
    priority_close: Option<Message>,
    close_attempted: bool,
    reserved: usize,
    in_flight: usize,
    stopping: bool,
    closed: bool,
}
struct SocketWriter {
    state: Arc<(Mutex<WriterState>, std::sync::Condvar)>,
    control: std::net::TcpStream,
    handle: Mutex<Option<JoinHandle<()>>>,
}
impl SocketWriter {
    fn start(stream: std::net::TcpStream, paused: Option<Arc<AtomicBool>>) -> Self {
        let control = stream.try_clone().expect("clone writer socket");
        let _ = stream.set_write_timeout(Some(Duration::from_millis(100)));
        let state = Arc::new((
            Mutex::new(WriterState::default()),
            std::sync::Condvar::new(),
        ));
        let writer_state = state.clone();
        let handle = thread::spawn(move || {
            let mut socket = tungstenite::WebSocket::from_raw_socket(
                stream,
                tungstenite::protocol::Role::Server,
                Some(websocket_config()),
            );
            loop {
                let item = {
                    let (gate, ready) = &*writer_state;
                    let mut state = gate.lock().unwrap();
                    while state.queue.is_empty()
                        && state.priority_close.is_none()
                        && !state.stopping
                    {
                        state = ready.wait(state).unwrap();
                    }
                    if state.stopping {
                        break;
                    }
                    let priority = state.priority_close.is_some();
                    if !priority
                        && paused
                            .as_ref()
                            .is_some_and(|flag| flag.load(Ordering::Acquire))
                    {
                        drop(state);
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    let item = if let Some(message) = state.priority_close.take() {
                        WriterItem {
                            kind: WriterKind::Control,
                            message,
                        }
                    } else {
                        state.queue.pop_front().unwrap()
                    };
                    state.in_flight += 1;
                    (item, priority)
                };
                let sent = socket.send(item.0.message).is_ok();
                let mut state = writer_state.0.lock().unwrap();
                state.in_flight -= 1;
                if item.1 {
                    state.close_attempted = true;
                }
                writer_state.1.notify_all();
                if !sent || item.1 {
                    break;
                }
            }
            let mut state = writer_state.0.lock().unwrap();
            state.closed = true;
            state.queue.clear();
            state.reserved = 0;
            state.in_flight = 0;
            writer_state.1.notify_all();
        });
        Self {
            state,
            control,
            handle: Mutex::new(Some(handle)),
        }
    }
    #[cfg(test)]
    fn occupancy(&self) -> usize {
        let state = self.state.0.lock().unwrap();
        state.queue.len() + state.reserved + state.in_flight
    }
    fn reserve(&self) -> Result<(), Close> {
        let mut state = self.state.0.lock().unwrap();
        if state.closed
            || state.stopping
            || state.queue.len() + state.reserved + state.in_flight >= MAX_OUTBOUND_QUEUE
        {
            return Err(Close {
                code: 1013,
                reason: "Client too slow",
            });
        }
        state.reserved += 1;
        Ok(())
    }
    fn complete(&self, message: Message) -> bool {
        let mut state = self.state.0.lock().unwrap();
        if state.reserved == 0 || state.stopping || state.closed {
            return false;
        }
        state.reserved -= 1;
        state.queue.push_back(WriterItem {
            kind: WriterKind::Response,
            message,
        });
        self.state.1.notify_one();
        true
    }
    fn event(&self, kind: WriterKind, message: Message) {
        let mut state = self.state.0.lock().unwrap();
        if state.closed || state.stopping {
            return;
        }
        if kind == WriterKind::Control {
            state.queue.push_front(WriterItem { kind, message });
            self.state.1.notify_one();
            return;
        }
        if kind == WriterKind::Status {
            if let Some(index) = state
                .queue
                .iter()
                .position(|item| item.kind == WriterKind::Status)
            {
                state.queue.remove(index);
            }
        }
        if state.queue.len() + state.reserved + state.in_flight >= MAX_OUTBOUND_QUEUE {
            let replace = match kind {
                WriterKind::Log => state
                    .queue
                    .iter()
                    .position(|item| item.kind == WriterKind::Log),
                WriterKind::Exit => state.queue.iter().position(|item| {
                    !matches!(item.kind, WriterKind::Response | WriterKind::Control)
                }),
                WriterKind::Status => state
                    .queue
                    .iter()
                    .position(|item| item.kind == WriterKind::Status),
                _ => None,
            };
            if let Some(index) = replace {
                state.queue.remove(index);
            } else {
                return;
            }
        }
        state.queue.push_back(WriterItem { kind, message });
        self.state.1.notify_one();
    }
    fn close(&self, code: tungstenite::protocol::frame::coding::CloseCode, reason: &'static str) {
        let mut state = self.state.0.lock().unwrap();
        if !state.closed && !state.stopping {
            state.priority_close = Some(Message::Close(Some(tungstenite::protocol::CloseFrame {
                code,
                reason: reason.into(),
            })));
            self.state.1.notify_one();
        }
    }
    fn is_closed(&self) -> bool {
        self.state.0.lock().unwrap().closed
    }
    fn shutdown(&self) {
        {
            let (gate, changed) = &*self.state;
            let mut state = gate.lock().unwrap();
            if state.priority_close.is_some() && !state.close_attempted && !state.closed {
                let (next, _) = changed
                    .wait_timeout_while(state, Duration::from_millis(250), |state| {
                        !state.close_attempted && !state.closed
                    })
                    .unwrap();
                state = next;
            }
            state.stopping = true;
            changed.notify_all();
        }
        let _ = self.control.shutdown(std::net::Shutdown::Both);
        if let Some(handle) = self.handle.lock().unwrap().take() {
            let _ = handle.join();
        }
    }
}
impl Drop for SocketWriter {
    fn drop(&mut self) {
        self.shutdown();
    }
}
#[cfg(test)]
impl OutboundQueue {
    pub fn reserve(&mut self) -> Result<(), Close> {
        if self.frames.len() + self.reserved >= MAX_OUTBOUND_QUEUE {
            return Err(Close {
                code: 1013,
                reason: "Client too slow",
            });
        }
        self.reserved += 1;
        Ok(())
    }
    pub fn complete(&mut self, frame: Arc<[u8]>) {
        self.reserved -= 1;
        self.frames.push_back(frame);
    }
    #[cfg(test)]
    pub fn occupancy(&self) -> usize {
        self.frames.len() + self.reserved
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Close {
    pub code: u16,
    pub reason: &'static str,
}
#[derive(Clone)]
struct Terminal {
    hash: [u8; 32],
    response: Arc<[u8]>,
    completed: Instant,
}

struct Pending {
    hash: [u8; 32],
    waiters: HashSet<u64>,
    result: Arc<(Mutex<Option<Arc<[u8]>>>, std::sync::Condvar)>,
}

enum DedupEntry {
    Pending(Pending),
    Terminal(Terminal),
}

pub struct ProtocolCore {
    config: Arc<ConfigStore>,
    action: Arc<dyn Fn(Operation) -> Result<(), String> + Send + Sync>,
    snapshot: Arc<Mutex<crate::supervisor::Snapshot>>,
    dedup: Mutex<HashMap<(String, String), DedupEntry>>,
    rates: Mutex<HashMap<String, (VecDeque<Instant>, VecDeque<Instant>)>>,
    requests_started: AtomicUsize,
}
#[derive(Clone)]
struct SessionContext {
    service_id: Arc<String>,
    connection_id: Arc<String>,
    snapshot_seq: Arc<AtomicU64>,
    event_seq: Arc<AtomicU64>,
}

impl ProtocolCore {
    pub fn new(config: Arc<ConfigStore>, supervisor: Supervisor) -> Self {
        let snapshot = supervisor.snapshot.clone();
        Self {
            config,
            action: Arc::new(move |op| supervisor.request(op)),
            snapshot,
            dedup: Mutex::new(HashMap::new()),
            rates: Mutex::new(HashMap::new()),
            requests_started: AtomicUsize::new(0),
        }
    }

    #[cfg(test)]
    fn mocked(
        config: Arc<ConfigStore>,
        action: Arc<dyn Fn(Operation) -> Result<(), String> + Send + Sync>,
    ) -> Self {
        Self {
            config,
            action,
            snapshot: Arc::new(Mutex::new(crate::supervisor::Snapshot::default())),
            dedup: Mutex::new(HashMap::new()),
            rates: Mutex::new(HashMap::new()),
            requests_started: AtomicUsize::new(0),
        }
    }

    #[cfg(test)]
    pub fn authorized_request(
        self: &Arc<Self>,
        capability_id: &str,
        socket_id: u64,
        bytes: &[u8],
        queue: &mut OutboundQueue,
    ) -> Result<Arc<[u8]>, Close> {
        queue.reserve()?;
        let response = self.process(capability_id, socket_id, bytes, None);
        queue.complete(response.clone());
        Ok(response)
    }

    fn process(
        self: &Arc<Self>,
        capability_id: &str,
        socket_id: u64,
        bytes: &[u8],
        session: Option<&SessionContext>,
    ) -> Arc<[u8]> {
        self.requests_started.fetch_add(1, Ordering::AcqRel);
        let invalid = || {
            encode(error(
                None,
                "invalid_request",
                "Request is not valid",
                false,
            ))
        };
        if bytes.len() > MAX_WS_MESSAGE_BYTES {
            return invalid();
        }
        let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
            return invalid();
        };
        if validate_value(&value, 1).is_err() {
            return invalid();
        }
        let Some(object) = value.as_object() else {
            return invalid();
        };
        if !exact_keys(object, &["v", "type", "requestId", "body"]) {
            return invalid();
        }
        let request_id = match object
            .get("requestId")
            .and_then(Value::as_str)
            .filter(|id| valid_request_id(id))
        {
            Some(v) => v,
            None => return invalid(),
        };
        let kind = match object.get("type").and_then(Value::as_str) {
            Some(v) => v,
            None => return invalid(),
        };
        if object.get("v") != Some(&json!(1)) {
            return encode(error(
                Some(request_id),
                "unsupported_version",
                "Protocol version is not supported",
                false,
            ));
        }
        let Some(body) = object.get("body").and_then(Value::as_object) else {
            return invalid();
        };
        let canonical = serde_json::to_vec(&json!({"v":1,"type":kind,"body":body})).unwrap();
        let hash: [u8; 32] = Sha256::digest(canonical).into();
        let key = (capability_id.to_owned(), request_id.to_owned());
        let mut cache = self.dedup.lock().unwrap();
        cache.retain(|_, entry| match entry {
            DedupEntry::Pending(_) => true,
            DedupEntry::Terminal(entry) => {
                entry.completed.elapsed() <= Duration::from_millis(MAX_DEDUP_AGE_MS)
            }
        });
        if let Some(entry) = cache.get_mut(&key) {
            let (existing_hash, result) = match entry {
                DedupEntry::Terminal(entry) => {
                    if entry.hash == hash {
                        return entry.response.clone();
                    }
                    (entry.hash, None)
                }
                DedupEntry::Pending(entry) => {
                    if entry.hash == hash
                        && (entry.waiters.contains(&socket_id) || entry.waiters.len() < MAX_CLIENTS)
                    {
                        entry.waiters.insert(socket_id);
                        (entry.hash, Some(entry.result.clone()))
                    } else {
                        (entry.hash, None)
                    }
                }
            };
            if existing_hash != hash {
                return encode(error(
                    Some(request_id),
                    "conflict",
                    "Request ID was already used",
                    false,
                ));
            }
            let Some(result) = result else {
                return encode(error(Some(request_id), "busy", "Service is busy", true));
            };
            drop(cache);
            return self.wait_for_result(&key, hash, result, request_id, deadline_for(kind));
        }
        if cache.len() >= MAX_DEDUP_ENTRIES {
            return encode(error(Some(request_id), "busy", "Service is busy", true));
        }
        let command = matches!(
            kind,
            "config.patch" | "uplink.start" | "uplink.stop" | "sidecar.restart"
        );
        if !self.admit(capability_id, command) {
            return encode(error(
                Some(request_id),
                "rate_limited",
                "Too many requests",
                true,
            ));
        }
        let result = Arc::new((Mutex::new(None), std::sync::Condvar::new()));
        cache.insert(
            key.clone(),
            DedupEntry::Pending(Pending {
                hash,
                waiters: HashSet::new(),
                result: result.clone(),
            }),
        );
        drop(cache);
        let core = self.clone();
        let kind_owned = kind.to_owned();
        let id_owned = request_id.to_owned();
        let body_owned = body.clone();
        let session_owned = session.cloned();
        let worker_result = result.clone();
        let worker_key = key.clone();
        thread::spawn(move || {
            let response =
                encode(core.execute(&kind_owned, &id_owned, &body_owned, session_owned.as_ref()));
            let mut cache = core.dedup.lock().unwrap();
            if matches!(cache.get(&worker_key), Some(DedupEntry::Pending(p)) if p.hash == hash) {
                cache.insert(
                    worker_key,
                    DedupEntry::Terminal(Terminal {
                        hash,
                        response: response.clone(),
                        completed: Instant::now(),
                    }),
                );
                let (slot, ready) = &*worker_result;
                *slot.lock().unwrap() = Some(response);
                ready.notify_all();
            }
        });
        self.wait_for_result(&key, hash, result, request_id, deadline_for(kind))
    }

    fn wait_for_result(
        &self,
        key: &(String, String),
        hash: [u8; 32],
        result: Arc<(Mutex<Option<Arc<[u8]>>>, std::sync::Condvar)>,
        request_id: &str,
        deadline: Duration,
    ) -> Arc<[u8]> {
        let (slot, ready) = &*result;
        let guard = slot.lock().unwrap();
        let (mut guard, _) = ready
            .wait_timeout_while(guard, deadline, |value| value.is_none())
            .unwrap();
        if let Some(response) = guard.clone() {
            return response;
        }
        let response = encode(error(
            Some(request_id),
            "timeout",
            "Operation timed out",
            true,
        ));
        let mut cache = self.dedup.lock().unwrap();
        if matches!(cache.get(key), Some(DedupEntry::Pending(p)) if p.hash == hash) {
            cache.insert(
                key.clone(),
                DedupEntry::Terminal(Terminal {
                    hash,
                    response: response.clone(),
                    completed: Instant::now(),
                }),
            );
            *guard = Some(response.clone());
            ready.notify_all();
        }
        guard.clone().unwrap_or(response)
    }

    fn admit(&self, capability: &str, command: bool) -> bool {
        let now = Instant::now();
        let mut rates = self.rates.lock().unwrap();
        let (requests, commands) = rates.entry(capability.into()).or_default();
        while requests
            .front()
            .is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(10))
        {
            requests.pop_front();
        }
        while commands
            .front()
            .is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(10))
        {
            commands.pop_front();
        }
        if requests.len() >= MAX_REQUESTS_PER_10S
            || (command && commands.len() >= MAX_COMMANDS_PER_10S)
        {
            return false;
        }
        requests.push_back(now);
        if command {
            commands.push_back(now)
        }
        true
    }

    fn execute(
        &self,
        kind: &str,
        id: &str,
        body: &Map<String, Value>,
        session: Option<&SessionContext>,
    ) -> Value {
        match kind {
            "config.get" if body.is_empty() => match gauge_config(&self.config) {
                Ok(config) => response(id, "config.result", json!({"ok":true,"config":config})),
                Err(_) => error(Some(id), "internal", "Service error", true),
            },
            "config.path.get" if body.is_empty() => response(
                id,
                "config.path.result",
                json!({"display":"Managed by MSFSLogger desktop"}),
            ),
            "state.get" if body.is_empty() => match session {
                Some(session) => response(id, "state.full", full_state_body(self, session)),
                None => error(Some(id), "internal", "Service error", true),
            },
            "config.patch" => self.patch(id, body),
            "uplink.start" | "uplink.stop" | "sidecar.restart" if body.is_empty() => {
                let operation = match kind {
                    "uplink.start" => Operation::Start,
                    "uplink.stop" => Operation::Stop,
                    _ => Operation::Restart,
                };
                match (self.action)(operation) {
                    Ok(()) => response(
                        id,
                        "command.result",
                        json!({"ok":true,"command":kind,"acceptedAt":now()}),
                    ),
                    Err(_) => error(Some(id), "busy", "Service is busy", true),
                }
            }
            "auth.request" | "pair.request" => {
                error(Some(id), "forbidden", "Request is not allowed", false)
            }
            "state.get" | "config.get" | "config.path.get" | "uplink.start" | "uplink.stop"
            | "sidecar.restart" => {
                error(Some(id), "invalid_request", "Request is not valid", false)
            }
            _ => error(
                Some(id),
                "unknown_type",
                "Request type is not supported",
                false,
            ),
        }
    }

    fn patch(&self, id: &str, body: &Map<String, Value>) -> Value {
        if !exact_keys(body, &["patch"]) {
            return error(Some(id), "invalid_request", "Request is not valid", false);
        }
        let Some(patch) = body.get("patch").and_then(Value::as_object) else {
            return error(Some(id), "invalid_request", "Request is not valid", false);
        };
        if patch.is_empty() || patch.iter().any(|(k, v)| !valid_patch(k, v)) {
            return error(Some(id), "invalid_request", "Request is not valid", false);
        }
        match self.config.save(Value::Object(patch.clone())) {
            Err(_) => error(
                Some(id),
                "invalid_request",
                "Configuration is not valid",
                false,
            ),
            Ok(()) => match (self.action)(Operation::Reload) {
                Err(_) => error(
                    Some(id),
                    "busy",
                    "Configuration saved; reload unavailable",
                    true,
                ),
                Ok(()) => match gauge_config(&self.config) {
                    Ok(config) => response(id, "config.result", json!({"ok":true,"config":config})),
                    Err(_) => error(Some(id), "internal", "Service error", true),
                },
            },
        }
    }
}

fn deadline_for(kind: &str) -> Duration {
    Duration::from_millis(if kind == "config.patch" {
        MAX_CONFIG_RESULT_WAIT_MS
    } else {
        MAX_COMMAND_RESULT_WAIT_MS
    })
}

fn full_state_body(core: &ProtocolCore, session: &SessionContext) -> Value {
    let snapshot_seq = session.snapshot_seq.fetch_add(1, Ordering::AcqRel) + 1;
    let event_seq = session.event_seq.fetch_add(1, Ordering::AcqRel) + 1;
    json!({
        "serviceInstanceId": session.service_id.as_str(),
        "connectionId": session.connection_id.as_str(),
        "snapshotSeq": snapshot_seq,
        "eventSeq": event_seq,
        "generatedAt": now(),
        "config": gauge_config(&core.config).unwrap_or(Value::Null),
        "status": project_status(crate::config::lock(&core.snapshot).status.as_ref(), &core.config)
    })
}

fn valid_patch(key: &str, value: &Value) -> bool {
    match key {
        "serverUrl" => value
            .as_str()
            .is_some_and(|s| s.len() <= 2048 && sanitize_url(s).is_some()),
        "trafficEnabled" | "autoUplink" => value.is_boolean(),
        "trafficRadiusM" => value.as_u64().is_some_and(|n| (1000..=200000).contains(&n)),
        "sim" => matches!(value.as_str(), Some("2020" | "2024")),
        "ingestToken" => value
            .as_str()
            .is_some_and(|s| !s.trim().is_empty() && s.trim().len() <= 2048),
        _ => false,
    }
}

pub fn gauge_config(store: &ConfigStore) -> Result<Value, String> {
    let raw = store.read()?;
    let exists = raw.is_some();
    let raw = raw.unwrap_or_default();
    let token_set = raw
        .get("ingestToken")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty());
    let config = json!({"version":1,"serverUrl":raw.get("serverUrl").and_then(Value::as_str).and_then(sanitize_url).unwrap_or_default(),"trafficEnabled":raw.get("trafficEnabled").and_then(Value::as_bool).unwrap_or(true),"trafficRadiusM":raw.get("trafficRadiusM").and_then(Value::as_u64).filter(|n|(1000..=200000).contains(n)).unwrap_or(40000),"sim":raw.get("sim").and_then(Value::as_str).filter(|s|matches!(*s,"2020"|"2024")).unwrap_or("2020"),"autoUplink":raw.get("autoUplink").and_then(Value::as_bool).unwrap_or(false),"tokenSet":token_set});
    Ok(json!({"exists":exists,"config":if exists {config} else {Value::Null}}))
}

fn sanitize_url(raw: &str) -> Option<String> {
    let mut u = Url::parse(raw).ok()?;
    if !matches!(u.scheme(), "http" | "https") {
        return None;
    }
    let _ = u.set_username("");
    let _ = u.set_password(None);
    u.set_query(None);
    u.set_fragment(None);
    Some(u.to_string())
}
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_STATUS_PROBLEMS: usize = 32;

fn status_int(obj: &Map<String, Value>, field: &str) -> Option<u64> {
    obj.get(field)
        .and_then(Value::as_u64)
        .filter(|n| *n <= MAX_SAFE_INTEGER)
}
fn status_nullable_int(obj: &Map<String, Value>, field: &str) -> Value {
    status_int(obj, field).map_or(Value::Null, Value::from)
}
fn status_bool(obj: &Map<String, Value>, field: &str, default: bool) -> bool {
    obj.get(field).and_then(Value::as_bool).unwrap_or(default)
}
fn status_text(obj: &Map<String, Value>, field: &str, default: &str, store: &ConfigStore) -> Value {
    let raw = obj.get(field).and_then(Value::as_str).unwrap_or(default);
    Value::String(truncate(&store.redact_text(raw), MAX_LOG_MESSAGE_BYTES))
}
fn status_nullable_text(obj: &Map<String, Value>, field: &str, store: &ConfigStore) -> Value {
    obj.get(field)
        .and_then(Value::as_str)
        .map_or(Value::Null, |s| {
            Value::String(truncate(&store.redact_text(s), MAX_LOG_MESSAGE_BYTES))
        })
}

// The gauge validates the presence and type of every status field, while the
// sidecar and the shell's synthetic statuses omit or null the ones they have no
// value for. Normalize to the complete schema here so a sparse status is never
// rejected by the gauge as a protocol error.
pub fn project_status(status: Option<&Value>, store: &ConfigStore) -> Value {
    let Some(source) = status.and_then(Value::as_object) else {
        return Value::Null;
    };
    let axis = |key: &str| {
        source
            .get(key)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
    };
    let (app, sim, backend, pause, traffic) = (
        axis("app"),
        axis("sim"),
        axis("backend"),
        axis("pause"),
        axis("traffic"),
    );
    let state = app
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("app.starting");
    let problems: Vec<Value> = app
        .get("problems")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_object)
                .take(MAX_STATUS_PROBLEMS)
                .map(|p| {
                    let field = p
                        .get("field")
                        .and_then(Value::as_str)
                        .filter(|f| {
                            matches!(
                                *f,
                                "serverUrl"
                                    | "trafficEnabled"
                                    | "trafficRadiusM"
                                    | "sim"
                                    | "autoUplink"
                                    | "ingestToken"
                            )
                        })
                        .unwrap_or("general");
                    json!({
                        "field": field,
                        "code": status_text(p, "code", "invalid", store),
                        "message": status_text(p, "message", "", store),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    json!({
        "v": 1,
        "type": "status",
        "at": source
            .get("at")
            .and_then(Value::as_u64)
            .filter(|n| *n <= MAX_SAFE_INTEGER)
            .unwrap_or_else(now),
        "app": {
            "state": status_text(&app, "state", "app.starting", store),
            "running": status_bool(&app, "running", state == "app.running"),
            "problems": problems,
            "restarting": status_bool(&app, "restarting", false),
            "restartsRemaining": status_int(&app, "restartsRemaining").map_or(5, |n| n.min(5)),
        },
        "sim": {
            "state": status_text(&sim, "state", "sim.idle", store),
            "attempt": status_int(&sim, "attempt").unwrap_or(0),
            "nextRetryAt": status_nullable_int(&sim, "nextRetryAt"),
            "retryDelayMs": status_nullable_int(&sim, "retryDelayMs"),
            "protocol": status_text(&sim, "protocol", "", store),
            "appName": status_text(&sim, "appName", "", store),
            "appVersion": status_nullable_text(&sim, "appVersion", store),
            "lastError": status_nullable_text(&sim, "lastError", store),
        },
        "backend": {
            "state": status_text(&backend, "state", "net.idle", store),
            "httpStatus": status_int(&backend, "httpStatus")
                .filter(|n| (100..=599).contains(n))
                .map_or(Value::Null, Value::from),
            "lastOkAt": status_nullable_int(&backend, "lastOkAt"),
            "lastErrorAt": status_nullable_int(&backend, "lastErrorAt"),
            "message": status_nullable_text(&backend, "message", store),
        },
        "pause": {
            "state": status_text(&pause, "state", "pause.off", store),
            "flags": status_int(&pause, "flags").unwrap_or(0),
            "label": status_text(&pause, "label", "", store),
            "usingPauseEx1": status_bool(&pause, "usingPauseEx1", false),
        },
        "traffic": {
            "enabled": status_bool(&traffic, "enabled", false),
            "radiusM": status_int(&traffic, "radiusM").unwrap_or(0),
            "lastSweepAt": status_nullable_int(&traffic, "lastSweepAt"),
            "lastBatchSize": status_nullable_int(&traffic, "lastBatchSize"),
            "lastError": status_nullable_text(&traffic, "lastError", store),
        },
        "config": gauge_config(store)
            .ok()
            .and_then(|v| v.get("config").cloned())
            .unwrap_or(Value::Null),
    })
}
fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.into();
    }
    let mut end = max.saturating_sub(3);
    while !s.is_char_boundary(end) {
        end -= 1
    }
    format!("{}…", &s[..end])
}
fn validate_value(v: &Value, depth: usize) -> Result<(), ()> {
    if depth > MAX_JSON_DEPTH {
        return Err(());
    }
    match v {
        Value::String(s) if s.len() > MAX_STRING_BYTES => Err(()),
        Value::Array(a) if a.len() > MAX_ARRAY_ITEMS => Err(()),
        Value::Object(o) if o.len() > MAX_OBJECT_KEYS => Err(()),
        Value::Array(a) => a.iter().try_for_each(|v| validate_value(v, depth + 1)),
        Value::Object(o) => o.values().try_for_each(|v| validate_value(v, depth + 1)),
        _ => Ok(()),
    }
}
fn exact_keys(o: &Map<String, Value>, keys: &[&str]) -> bool {
    o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k))
}
fn valid_request_id(id: &str) -> bool {
    (16..=MAX_REQUEST_ID_BYTES).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn response(id: &str, kind: &str, body: Value) -> Value {
    json!({"v":1,"type":kind,"requestId":id,"body":body})
}
fn error(id: Option<&str>, code: &str, message: &str, retryable: bool) -> Value {
    json!({"v":1,"type":"error","requestId":id.unwrap_or("0000000000000000"),"body":{"code":code,"message":truncate(message,MAX_ERROR_MESSAGE_BYTES),"retryable":retryable}})
}
fn encode(value: Value) -> Arc<[u8]> {
    serde_json::to_vec(&value).unwrap().into()
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(9_007_199_254_740_991) as u64
}
pub fn random_id(bytes: usize) -> String {
    let mut value = vec![0; bytes];
    getrandom::fill(&mut value).expect("OS random source unavailable");
    URL_SAFE_NO_PAD.encode(value)
}

#[derive(Clone)]
struct Verifier {
    id: String,
    salt: [u8; 16],
    hash: [u8; 32],
    created: u64,
    last_used: u64,
}
struct PairCode {
    code: [u8; 8],
    created: Instant,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FirstEnvelope {
    v: u8,
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "requestId")]
    request_id: String,
    body: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthBody {
    capability: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PairBody {
    code: String,
    #[serde(rename = "clientLabel")]
    client_label: String,
}

pub struct Authorization {
    path: PathBuf,
    verifier: Mutex<Option<Verifier>>,
    pair: Mutex<Option<PairCode>>,
    epoch: AtomicU64,
    attempts: Mutex<VecDeque<Instant>>,
    corrupt: AtomicBool,
    capability_epoch: Mutex<String>,
    clients: Mutex<HashMap<u64, mpsc::Sender<()>>>,
    invalidate: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    fail_before_replace: AtomicBool,
}
impl Authorization {
    pub fn load(path: PathBuf) -> Self {
        let read = fs::read(&path);
        Self::from_read(path, read)
    }
    fn from_read(path: PathBuf, read: io::Result<Vec<u8>>) -> Self {
        let (bytes, unreadable) = match read {
            Ok(bytes) => (Some(bytes), false),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (None, false),
            Err(_) => (None, true),
        };
        let parsed = bytes
            .as_ref()
            .and_then(|b| serde_json::from_slice::<Value>(b).ok());
        let valid_unpaired = parsed.as_ref().is_some_and(|v| {
            v.as_object().is_some_and(|o| {
                exact_keys(
                    o,
                    &[
                        "v",
                        "capabilityEpoch",
                        "capabilityId",
                        "salt",
                        "verifier",
                        "created",
                        "lastUsed",
                    ],
                )
            }) && v["v"] == json!(1)
                && v["capabilityEpoch"]
                    .as_str()
                    .is_some_and(|s| URL_SAFE_NO_PAD.decode(s).is_ok_and(|b| b.len() == 16))
                && ["capabilityId", "salt", "verifier", "created", "lastUsed"]
                    .iter()
                    .all(|key| v[*key].is_null())
        });
        let verifier = parsed.as_ref().and_then(|v| {
            if !v.as_object().is_some_and(|o| {
                exact_keys(
                    o,
                    &[
                        "v",
                        "capabilityEpoch",
                        "capabilityId",
                        "salt",
                        "verifier",
                        "created",
                        "lastUsed",
                    ],
                )
            }) || v["v"] != json!(1)
            {
                return None;
            }
            if !v["capabilityEpoch"]
                .as_str()
                .is_some_and(|s| URL_SAFE_NO_PAD.decode(s).is_ok_and(|b| b.len() == 16))
            {
                return None;
            }
            let salt = URL_SAFE_NO_PAD.decode(v["salt"].as_str()?).ok()?;
            let hash = URL_SAFE_NO_PAD.decode(v["verifier"].as_str()?).ok()?;
            Some(Verifier {
                id: v["capabilityId"].as_str()?.into(),
                salt: salt.try_into().ok()?,
                hash: hash.try_into().ok()?,
                created: v["created"].as_u64()?,
                last_used: v["lastUsed"].as_u64()?,
            })
        });
        let corrupt = unreadable || (bytes.is_some() && verifier.is_none() && !valid_unpaired);
        Self {
            path,
            verifier: Mutex::new(verifier),
            pair: Mutex::new(None),
            epoch: AtomicU64::new(1),
            attempts: Mutex::new(VecDeque::new()),
            corrupt: AtomicBool::new(corrupt),
            capability_epoch: Mutex::new(
                parsed
                    .as_ref()
                    .and_then(|v| v["capabilityEpoch"].as_str())
                    .unwrap_or("")
                    .into(),
            ),
            clients: Mutex::new(HashMap::new()),
            invalidate: Mutex::new(None),
            fail_before_replace: AtomicBool::new(false),
        }
    }
    fn set_invalidate(&self, callback: Arc<dyn Fn() + Send + Sync>) {
        *self.invalidate.lock().unwrap() = Some(callback);
    }
    fn invalidate_clients(&self) {
        for (_, client) in self.clients.lock().unwrap().drain() {
            let _ = client.send(());
        }
        if let Some(callback) = self.invalidate.lock().unwrap().as_ref() {
            callback();
        }
    }
    fn register_client(&self, socket_id: u64) -> mpsc::Receiver<()> {
        let (sender, receiver) = mpsc::channel();
        self.clients.lock().unwrap().insert(socket_id, sender);
        receiver
    }
    fn unregister_client(&self, socket_id: u64) {
        self.clients.lock().unwrap().remove(&socket_id);
    }
    pub fn begin_pairing(&self, confirm_corrupt: bool) -> Value {
        let corrupt = self.corrupt.load(Ordering::Acquire);
        if confirm_corrupt && !corrupt {
            return json!({"ok":false,"code":"invalid_confirmation","message":"Confirmation is only valid for unreadable pairing data"});
        }
        if corrupt && !confirm_corrupt {
            return json!({"ok":false,"code":"confirmation_required","message":"Pairing data is unreadable; confirm reset to continue"});
        }
        let n = random_u32() % 100_000_000;
        let text = format!("{n:08}");
        let mut code = [0; 8];
        code.copy_from_slice(text.as_bytes());
        if corrupt {
            let epoch = random_id(16);
            let record = json!({"v":1,"capabilityEpoch":epoch,"capabilityId":Value::Null,"salt":Value::Null,"verifier":Value::Null,"created":Value::Null,"lastUsed":Value::Null});
            if self.atomic_persist(&record).is_err() {
                return json!({"ok":false,"code":"internal","message":"Pairing could not be started"});
            }
            *self.capability_epoch.lock().unwrap() = epoch;
            *self.verifier.lock().unwrap() = None;
            self.attempts.lock().unwrap().clear();
            self.invalidate_clients();
            self.epoch.fetch_add(1, Ordering::AcqRel);
            self.corrupt.store(false, Ordering::Release);
        }
        *self.pair.lock().unwrap() = Some(PairCode {
            code,
            created: Instant::now(),
        });
        json!({"ok":true,"code":text,"expiresAt":now()+MAX_PAIR_CODE_AGE_MS})
    }
    pub fn revoke(&self) -> io::Result<()> {
        self.invalidate_clients();
        self.epoch.fetch_add(1, Ordering::AcqRel);
        *self.verifier.lock().unwrap() = None;
        *self.pair.lock().unwrap() = None;
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }
    pub fn pair(&self, code: &str) -> Option<(String, String)> {
        let now_attempt = Instant::now();
        let mut attempts = self.attempts.lock().unwrap();
        while attempts
            .front()
            .is_some_and(|t| now_attempt.duration_since(*t) >= Duration::from_secs(60))
        {
            attempts.pop_front();
        }
        if attempts.len() >= MAX_PAIR_ATTEMPTS_PER_60S {
            return None;
        }
        attempts.push_back(now_attempt);
        drop(attempts);
        if code.len() != 8 || !code.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let mut gate = self.pair.lock().unwrap();
        let pair = gate.as_ref()?;
        if pair.created.elapsed() > Duration::from_millis(MAX_PAIR_CODE_AGE_MS)
            || !constant_eq(pair.code.as_slice(), code.as_bytes())
        {
            return None;
        }
        *gate = None;
        drop(gate);
        let capability = random_id(32);
        let id = random_id(16);
        let mut salt = [0; 16];
        getrandom::fill(&mut salt).ok()?;
        let time = now();
        let verifier = Verifier {
            id: id.clone(),
            salt,
            hash: kdf(capability.as_bytes(), &salt),
            created: time,
            last_used: time,
        };
        if self.persist(&verifier).is_err() {
            return None;
        }
        self.invalidate_clients();
        *self.verifier.lock().unwrap() = Some(verifier);
        self.epoch.fetch_add(1, Ordering::AcqRel);
        Some((capability, id))
    }
    fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::Acquire)
    }
    pub fn authorize(&self, capability: &str) -> Option<String> {
        if capability.len() != 43 {
            return None;
        }
        let mut gate = self.verifier.lock().unwrap();
        let verifier = gate.as_mut()?;
        let hash = kdf(capability.as_bytes(), &verifier.salt);
        if !constant_eq(&hash, &verifier.hash) {
            return None;
        }
        if now().saturating_sub(verifier.last_used) >= 3_600_000 {
            let mut updated = verifier.clone();
            updated.last_used = now();
            if self.persist(&updated).is_ok() {
                *verifier = updated;
            }
        }
        Some(verifier.id.clone())
    }
    fn persist(&self, v: &Verifier) -> io::Result<()> {
        let epoch = {
            let mut e = self.capability_epoch.lock().unwrap();
            if e.is_empty() {
                *e = random_id(16)
            }
            e.clone()
        };
        self.atomic_persist(&json!({"v":1,"capabilityEpoch":epoch,"capabilityId":v.id,"salt":URL_SAFE_NO_PAD.encode(v.salt),"verifier":URL_SAFE_NO_PAD.encode(v.hash),"created":v.created,"lastUsed":v.last_used}))
    }
    fn atomic_persist(&self, value: &Value) -> io::Result<()> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| io::Error::other("permission path"))?;
        fs::create_dir_all(parent)?;
        let tmp = self.path.with_extension(format!("{}.tmp", random_id(6)));
        let bytes = serde_json::to_vec(value)?;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        use std::io::Write;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        if let Err(error) = set_user_only(&tmp) {
            let _ = fs::remove_file(&tmp);
            return Err(error);
        }
        if self.fail_before_replace.load(Ordering::Acquire) {
            let _ = fs::remove_file(&tmp);
            return Err(io::Error::other("injected replacement failure"));
        }
        #[cfg(windows)]
        {
            replace_file_windows(&tmp, &self.path)?;
            return Ok(());
        }
        #[cfg(not(windows))]
        let result = fs::rename(&tmp, &self.path);
        #[cfg(not(windows))]
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        #[cfg(not(windows))]
        result
    }
}

#[cfg(unix)]
fn set_user_only(path: &std::path::Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(windows)]
fn set_user_only(path: &std::path::Path) -> io::Result<()> {
    use std::{ffi::c_void, os::windows::ffi::OsStrExt, ptr};
    #[repr(C)]
    struct Trustee {
        multiple: *mut c_void,
        operation: i32,
        form: i32,
        kind: i32,
        name: *mut u16,
    }
    #[repr(C)]
    struct Access {
        permissions: u32,
        mode: i32,
        inheritance: u32,
        trustee: Trustee,
    }
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
        fn GetTokenInformation(
            token: *mut c_void,
            class: i32,
            info: *mut c_void,
            len: u32,
            needed: *mut u32,
        ) -> i32;
        fn SetEntriesInAclW(
            count: u32,
            entries: *mut Access,
            old: *mut c_void,
            new_acl: *mut *mut c_void,
        ) -> u32;
        fn SetNamedSecurityInfoW(
            name: *mut u16,
            object_type: i32,
            security: u32,
            owner: *mut c_void,
            group: *mut c_void,
            dacl: *mut c_void,
            sacl: *mut c_void,
        ) -> u32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }
    unsafe {
        let mut token = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), 0x0008, &mut token) == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut needed = 0;
        GetTokenInformation(token, 1, ptr::null_mut(), 0, &mut needed);
        let mut info = vec![0u8; needed as usize];
        if GetTokenInformation(token, 1, info.as_mut_ptr().cast(), needed, &mut needed) == 0 {
            CloseHandle(token);
            return Err(io::Error::last_os_error());
        }
        CloseHandle(token);
        let sid = *(info.as_ptr() as *const *mut c_void);
        let mut access = Access {
            permissions: 0x001F01FF,
            mode: 1,
            inheritance: 0,
            trustee: Trustee {
                multiple: ptr::null_mut(),
                operation: 0,
                form: 0,
                kind: 1,
                name: sid.cast(),
            },
        };
        let mut acl = ptr::null_mut();
        let status = SetEntriesInAclW(1, &mut access, ptr::null_mut(), &mut acl);
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let status = SetNamedSecurityInfoW(
            wide.as_mut_ptr(),
            1,
            0x00000004 | 0x80000000,
            ptr::null_mut(),
            ptr::null_mut(),
            acl,
            ptr::null_mut(),
        );
        LocalFree(acl);
        if status == 0 {
            Ok(())
        } else {
            Err(io::Error::from_raw_os_error(status as i32))
        }
    }
}

#[cfg(windows)]
fn replace_file_windows(temp: &std::path::Path, destination: &std::path::Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let from: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0x1 | 0x8) } != 0 {
        Ok(())
    } else {
        let error = io::Error::last_os_error();
        let _ = fs::remove_file(temp);
        Err(error)
    }
}
#[cfg(all(test, windows))]
fn assert_user_only_protected_dacl(path: &std::path::Path) {
    use std::{ffi::c_void, os::windows::ffi::OsStrExt, ptr};
    #[repr(C)]
    struct Acl {
        revision: u8,
        sbz1: u8,
        size: u16,
        ace_count: u16,
        sbz2: u16,
    }
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn GetNamedSecurityInfoW(
            name: *mut u16,
            kind: i32,
            info: u32,
            owner: *mut *mut c_void,
            group: *mut *mut c_void,
            dacl: *mut *mut c_void,
            sacl: *mut *mut c_void,
            descriptor: *mut *mut c_void,
        ) -> u32;
        fn GetSecurityDescriptorControl(
            descriptor: *mut c_void,
            control: *mut u16,
            revision: *mut u32,
        ) -> i32;
        fn GetAce(acl: *mut c_void, index: u32, ace: *mut *mut c_void) -> i32;
        fn EqualSid(first: *mut c_void, second: *mut c_void) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        let (mut owner, mut dacl, mut descriptor) =
            (ptr::null_mut(), ptr::null_mut(), ptr::null_mut());
        assert_eq!(
            GetNamedSecurityInfoW(
                wide.as_mut_ptr(),
                1,
                0x1 | 0x4,
                &mut owner,
                ptr::null_mut(),
                &mut dacl,
                ptr::null_mut(),
                &mut descriptor
            ),
            0
        );
        let (mut control, mut revision) = (0u16, 0u32);
        assert_ne!(
            GetSecurityDescriptorControl(descriptor, &mut control, &mut revision),
            0
        );
        assert_ne!(
            control & 0x1000,
            0,
            "DACL must be protected from inheritance"
        );
        assert_eq!(
            (*(dacl as *const Acl)).ace_count,
            1,
            "only the current user may be granted access"
        );
        let mut ace = ptr::null_mut();
        assert_ne!(GetAce(dacl, 0, &mut ace), 0);
        let ace_sid = (ace as *mut u8).add(8).cast();
        assert_ne!(
            EqualSid(owner, ace_sid),
            0,
            "the sole ACE must belong to the file owner/current user"
        );
        LocalFree(descriptor);
    }
}
fn random_u32() -> u32 {
    let mut b = [0; 4];
    getrandom::fill(&mut b).expect("OS random source unavailable");
    u32::from_le_bytes(b)
}
fn kdf(secret: &[u8], salt: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    pbkdf2_hmac::<Sha256>(secret, salt, 210_000, &mut out);
    out
}
fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |x, (a, b)| x | (a ^ b)) == 0
}

#[derive(Default)]
struct EventMailbox {
    events: Mutex<VecDeque<Event>>,
    dropped_logs: AtomicBool,
}
impl EventMailbox {
    fn push(&self, event: Event) {
        let mut events = self.events.lock().unwrap();
        match &event {
            Event::Status(_) => {
                if let Some(index) = events.iter().position(|v| matches!(v, Event::Status(_))) {
                    events.remove(index);
                }
            }
            Event::Log(_) if events.len() >= MAX_OUTBOUND_QUEUE => {
                if let Some(index) = events.iter().position(|v| matches!(v, Event::Log(_))) {
                    events.remove(index);
                    self.dropped_logs.store(true, Ordering::Release);
                } else {
                    return;
                }
            }
            Event::Exit(_) if events.len() >= MAX_OUTBOUND_QUEUE => {
                if let Some(index) = events.iter().position(|v| !matches!(v, Event::Exit(_))) {
                    events.remove(index);
                } else {
                    return;
                }
            }
            _ => {}
        }
        if events.len() < MAX_OUTBOUND_QUEUE {
            events.push_back(event);
        }
    }
    fn pop(&self) -> Option<Event> {
        self.events.lock().unwrap().pop_front()
    }
}

#[derive(Default)]
pub struct GaugeEventHub {
    clients: Mutex<Vec<Weak<EventMailbox>>>,
}
impl GaugeEventHub {
    pub fn publish(&self, event: Event) {
        self.clients.lock().unwrap().retain(|client| {
            if let Some(client) = client.upgrade() {
                client.push(event.clone());
                true
            } else {
                false
            }
        })
    }
    fn subscribe(&self) -> Arc<EventMailbox> {
        let mailbox = Arc::new(EventMailbox::default());
        self.clients.lock().unwrap().push(Arc::downgrade(&mailbox));
        mailbox
    }
}

pub struct GaugeService {
    stop: Arc<AtomicBool>,
    thread: Mutex<Option<JoinHandle<()>>>,
    pub authorization: Arc<Authorization>,
    core: Arc<ProtocolCore>,
    active: Arc<AtomicUsize>,
    #[cfg(test)]
    port: u16,
}
impl GaugeService {
    pub fn start(supervisor: Supervisor, hub: Arc<GaugeEventHub>) -> Result<Self, String> {
        Self::start_on(supervisor, hub, PRODUCTION_PORT, ALLOWED_GAUGE_ORIGINS)
    }
    fn start_on(
        supervisor: Supervisor,
        hub: Arc<GaugeEventHub>,
        port: u16,
        allowed: &'static [(&'static str, &'static str, Option<u16>)],
    ) -> Result<Self, String> {
        let listener =
            bind_loopback(port).map_err(|_| "Gauge synchronization port is unavailable")?;
        let actual_port = listener
            .local_addr()
            .map_err(|_| "Gauge synchronization listener unavailable")?
            .port();
        listener
            .set_nonblocking(true)
            .map_err(|_| "Gauge synchronization listener unavailable")?;
        let permission_path = supervisor
            .config
            .path
            .with_file_name("gauge-permissions.json");
        let core = Arc::new(ProtocolCore::new(
            supervisor.config.clone(),
            supervisor.clone(),
        ));
        Self::start_parts(listener, permission_path, core, hub, actual_port, allowed)
    }
    fn start_parts(
        listener: TcpListener,
        permission_path: PathBuf,
        core: Arc<ProtocolCore>,
        hub: Arc<GaugeEventHub>,
        port: u16,
        allowed: &'static [(&'static str, &'static str, Option<u16>)],
    ) -> Result<Self, String> {
        let clear_core = core.clone();
        let auth = Arc::new(Authorization::load(permission_path));
        auth.set_invalidate(Arc::new(move || {
            clear_core.dedup.lock().unwrap().clear();
            clear_core.rates.lock().unwrap().clear();
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = stop.clone();
        let auth2 = auth.clone();
        let active = Arc::new(AtomicUsize::new(0));
        let listener_active = active.clone();
        let service_id = Arc::new(random_id(16));
        let snapshot_seq = Arc::new(AtomicU64::new(0));
        let listener_core = core.clone();
        let handle = thread::Builder::new()
            .name("gauge-sync-listener".into())
            .spawn(move || {
                while !stop2.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((stream, peer)) => {
                            // Windows sockets inherit the listener's non-blocking mode, but the
                            // handshake and auth deadline rely on blocking reads with timeouts.
                            // Coherent sends its upgrade request after connecting, so a
                            // non-blocking read would drop every simulator connection.
                            if stream.set_nonblocking(false).is_err()
                                || !client_slot_available(listener_active.load(Ordering::Acquire))
                            {
                                drop(stream);
                                continue;
                            }
                            listener_active.fetch_add(1, Ordering::AcqRel);
                            let a = auth2.clone();
                            let c = listener_core.clone();
                            let count = listener_active.clone();
                            let events = hub.subscribe();
                            let service_id = service_id.clone();
                            let snapshot_seq = snapshot_seq.clone();
                            thread::spawn(move || {
                                serve(
                                    stream,
                                    peer,
                                    port,
                                    allowed,
                                    a,
                                    c,
                                    events,
                                    service_id,
                                    snapshot_seq,
                                    None,
                                );
                                count.fetch_sub(1, Ordering::AcqRel);
                            });
                        }
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(20))
                        }
                        Err(_) => break,
                    }
                }
            })
            .map_err(|_| "Cannot start gauge synchronization listener")?;
        Ok(Self {
            stop,
            thread: Mutex::new(Some(handle)),
            authorization: auth,
            core,
            active,
            #[cfg(test)]
            port,
        })
    }
    #[cfg(test)]
    fn start_test(
        core: Arc<ProtocolCore>,
        hub: Arc<GaugeEventHub>,
        allowed: &'static [(&'static str, &'static str, Option<u16>)],
    ) -> Result<Self, String> {
        Self::start_test_on(core, hub, allowed, 0)
    }
    #[cfg(test)]
    fn start_test_on(
        core: Arc<ProtocolCore>,
        hub: Arc<GaugeEventHub>,
        allowed: &'static [(&'static str, &'static str, Option<u16>)],
        requested_port: u16,
    ) -> Result<Self, String> {
        let listener = bind_loopback(requested_port)
            .map_err(|_| "Gauge synchronization port is unavailable")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "Gauge synchronization listener unavailable")?;
        let port = listener
            .local_addr()
            .map_err(|_| "Gauge synchronization listener unavailable")?
            .port();
        let permission_path = core.config.path.with_file_name("gauge-permissions.json");
        Self::start_parts(listener, permission_path, core, hub, port, allowed)
    }
    pub fn revoke(&self) -> io::Result<()> {
        self.authorization.revoke()?;
        self.core.dedup.lock().unwrap().clear();
        self.core.rates.lock().unwrap().clear();
        Ok(())
    }
    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::Release);
        self.authorization.invalidate_clients();
        if let Some(h) = self.thread.lock().unwrap().take() {
            let _ = h.join();
        }
        while self.active.load(Ordering::Acquire) != 0 {
            thread::sleep(Duration::from_millis(10));
        }
    }
}

fn client_slot_available(active: usize) -> bool {
    active < MAX_CLIENTS
}
impl Drop for GaugeService {
    fn drop(&mut self) {
        self.shutdown()
    }
}

fn serve(
    stream: std::net::TcpStream,
    peer: SocketAddr,
    port: u16,
    allowed: &[(&str, &str, Option<u16>)],
    auth: Arc<Authorization>,
    core: Arc<ProtocolCore>,
    events: Arc<EventMailbox>,
    service_id: Arc<String>,
    process_snapshot_seq: Arc<AtomicU64>,
    writer_pause: Option<Arc<AtomicBool>>,
) {
    debug_assert_eq!(MAX_INBOUND_IN_FLIGHT, 1);
    let websocket_config = websocket_config();
    let accepted = accept_hdr_with_config(
        stream,
        |request: &Request, mut response: Response| {
            let header_bytes = request.uri().to_string().len()
                + request
                    .headers()
                    .iter()
                    .map(|(k, v)| k.as_str().len() + v.as_bytes().len() + 4)
                    .sum::<usize>();
            if header_bytes > MAX_HTTP_HEADER_BYTES {
                return Err(HttpResponse::builder()
                    .status(StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE)
                    .header("Cache-Control", "no-store")
                    .body(Some(String::new()))
                    .unwrap());
            }
            let target = request
                .uri()
                .path_and_query()
                .map(|v| v.as_str())
                .unwrap_or("");
            let hosts: Vec<_> = request
                .headers()
                .get_all("host")
                .iter()
                .filter_map(|v| v.to_str().ok())
                .collect();
            let origins: Vec<_> = request
                .headers()
                .get_all("origin")
                .iter()
                .filter_map(|v| v.to_str().ok())
                .collect();
            let forwarded = request.headers().keys().any(|k| {
                k.as_str().eq_ignore_ascii_case("forwarded")
                    || k.as_str().to_ascii_lowercase().starts_with("x-forwarded-")
            });
            let code = validate_upgrade(peer, target, &hosts, &origins, forwarded, port, allowed);
            if code != 101 {
                let status = StatusCode::from_u16(code).unwrap_or(StatusCode::FORBIDDEN);
                return Err(HttpResponse::builder()
                    .status(status)
                    .header("Cache-Control", "no-store")
                    .body(Some(String::new()))
                    .unwrap());
            }
            response
                .headers_mut()
                .insert("Cache-Control", "no-store".parse().unwrap());
            Ok(response)
        },
        Some(websocket_config),
    );
    let Ok(mut ws) = accepted else { return };
    #[cfg(test)]
    test_stage(1);
    #[cfg(all(test, windows))]
    let auth_remaining = {
        let started = Instant::now();
        test_peek_frame(ws.get_ref(), started + Duration::from_secs(1));
        Duration::from_millis(MAX_AUTH_DEADLINE_MS).saturating_sub(started.elapsed())
    };
    #[cfg(not(all(test, windows)))]
    let auth_remaining = Duration::from_millis(MAX_AUTH_DEADLINE_MS);
    let _ = ws.get_mut().set_read_timeout(Some(auth_remaining));
    let first = match ws.read() {
        Ok(Message::Text(s)) if s.len() <= MAX_WS_MESSAGE_BYTES => {
            #[cfg(test)]
            TEST_FIRST_READ_OUTCOME.store(1, Ordering::Release);
            s
        }
        Ok(Message::Binary(_)) => {
            #[cfg(test)]
            TEST_FIRST_READ_OUTCOME.store(2, Ordering::Release);
            let _ = ws.close(Some(tungstenite::protocol::CloseFrame {
                code: tungstenite::protocol::frame::coding::CloseCode::Unsupported,
                reason: "Text required".into(),
            }));
            return;
        }
        Err(tungstenite::Error::Io(error))
            if matches!(
                error.kind(),
                io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
            ) =>
        {
            #[cfg(test)]
            TEST_FIRST_READ_OUTCOME.store(3, Ordering::Release);
            return;
        }
        Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
            #[cfg(test)]
            TEST_FIRST_READ_OUTCOME.store(4, Ordering::Release);
            return;
        }
        Err(tungstenite::Error::Protocol(_)) => {
            #[cfg(test)]
            TEST_FIRST_READ_OUTCOME.store(5, Ordering::Release);
            return;
        }
        Err(tungstenite::Error::Capacity(_)) => {
            #[cfg(test)]
            TEST_FIRST_READ_OUTCOME.store(6, Ordering::Release);
            return;
        }
        _ => {
            #[cfg(test)]
            TEST_FIRST_READ_OUTCOME.store(7, Ordering::Release);
            return;
        }
    };
    #[cfg(test)]
    test_stage(2);
    let parsed = serde_json::from_str::<FirstEnvelope>(&first)
        .ok()
        .filter(|v| {
            v.v == 1 && valid_request_id(&v.request_id) && validate_value(&v.body, 1).is_ok()
        });
    let Some(v) = parsed else {
        let _ = ws.close(Some(tungstenite::protocol::CloseFrame {
            code: tungstenite::protocol::frame::coding::CloseCode::Policy,
            reason: "Protocol violation".into(),
        }));
        return;
    };
    #[cfg(test)]
    test_stage(3);
    let id = v.request_id.as_str();
    let authorized = match v.kind.as_str() {
        "auth.request" => serde_json::from_value::<AuthBody>(v.body)
            .ok()
            .filter(|b| {
                URL_SAFE_NO_PAD
                    .decode(&b.capability)
                    .is_ok_and(|v| v.len() == 32)
            })
            .and_then(|b| auth.authorize(&b.capability))
            .map(|cap| (cap, response(id, "auth.result", json!({"authorized":true})))),
        "pair.request" => serde_json::from_value::<PairBody>(v.body)
            .ok()
            .filter(|b| b.client_label == "MSFS CDU")
            .and_then(|b| auth.pair(&b.code))
            .map(|(cap, id2)| {
                (
                    id2.clone(),
                    response(
                        id,
                        "pair.result",
                        json!({"paired":true,"capability":cap,"capabilityId":id2}),
                    ),
                )
            }),
        _ => None,
    };
    let Some((cap_id, result)) = authorized else {
        let _ = ws.send(Message::Text(
            serde_json::to_string(&error(
                Some(id),
                "unauthorized",
                "Authorization failed",
                false,
            ))
            .unwrap()
            .into(),
        ));
        let _ = ws.close(Some(tungstenite::protocol::CloseFrame {
            code: tungstenite::protocol::frame::coding::CloseCode::Policy,
            reason: "Unauthorized".into(),
        }));
        return;
    };
    #[cfg(test)]
    test_stage(4);
    if ws
        .send(Message::Text(
            serde_json::to_string(&result).unwrap().into(),
        ))
        .is_err()
    {
        return;
    }
    #[cfg(test)]
    test_stage(5);
    let writer_stream = match ws.get_ref().try_clone() {
        Ok(stream) => stream,
        Err(_) => return,
    };
    let writer = SocketWriter::start(writer_stream, writer_pause);
    #[cfg(test)]
    test_stage(6);
    let connection_id = Arc::new(random_id(16));
    let session = SessionContext {
        service_id: service_id.clone(),
        connection_id: connection_id.clone(),
        snapshot_seq: process_snapshot_seq,
        event_seq: Arc::new(AtomicU64::new(0)),
    };
    let welcome = json!({"v":1,"type":"session.welcome","body":{"serviceInstanceId":service_id.as_str(),"connectionId":connection_id,"serverTime":now(),"capabilityId":cap_id}});
    let snapshot = json!({"v":1,"type":"state.full","body":full_state_body(&core, &session)});
    if writer.reserve().is_err()
        || !writer.complete(Message::Text(
            serde_json::to_string(&welcome).unwrap().into(),
        ))
    {
        return;
    }
    #[cfg(test)]
    test_stage(7);
    if writer.reserve().is_err()
        || !writer.complete(Message::Text(
            serde_json::to_string(&snapshot).unwrap().into(),
        ))
    {
        return;
    }
    #[cfg(test)]
    test_stage(8);
    let _ = ws
        .get_mut()
        .set_read_timeout(Some(Duration::from_millis(200)));
    let authorized_epoch = auth.epoch();
    let socket_id = NEXT_SOCKET_ID.fetch_add(1, Ordering::Relaxed);
    let revoked = auth.register_client(socket_id);
    let mut last_received = Instant::now();
    let mut ping_sent = None;
    loop {
        if writer.is_closed() {
            break;
        }
        if auth.epoch() != authorized_epoch || revoked.try_recv().is_ok() {
            writer.close(
                tungstenite::protocol::frame::coding::CloseCode::Policy,
                "Authorization revoked",
            );
            break;
        }
        loop {
            let next_event = if events.dropped_logs.swap(false, Ordering::AcqRel) {
                Some(Event::Log(
                    json!({"at":now(),"level":"warn","message":"Gauge log events were dropped"}),
                ))
            } else {
                events.pop()
            };
            match next_event {
                Some(event) => {
                    let event_seq = session.event_seq.fetch_add(1, Ordering::AcqRel) + 1;
                    let writer_kind = match &event {
                        Event::Status(_) => WriterKind::Status,
                        Event::Log(_) => WriterKind::Log,
                        Event::Exit(_) => WriterKind::Exit,
                    };
                    let envelope = match event {
                        Event::Status(v) => {
                            let snapshot_seq =
                                session.snapshot_seq.fetch_add(1, Ordering::AcqRel) + 1;
                            json!({"v":1,"type":"status.event","body":{"serviceInstanceId":service_id,"connectionId":connection_id,"snapshotSeq":snapshot_seq,"eventSeq":event_seq,"generatedAt":now(),"status":project_status(Some(&v),&core.config)}})
                        }
                        Event::Log(v) => {
                            json!({"v":1,"type":"log.event","body":{"serviceInstanceId":service_id,"connectionId":connection_id,"eventSeq":event_seq,"at":v["at"],"level":v["level"],"message":truncate(&core.config.redact_text(v["message"].as_str().unwrap_or("")),MAX_LOG_MESSAGE_BYTES)}})
                        }
                        Event::Exit(v) => {
                            json!({"v":1,"type":"exit.event","body":{"serviceInstanceId":service_id,"connectionId":connection_id,"eventSeq":event_seq,"at":now(),"code":v["code"],"signal":v["signal"],"restarting":v["restarting"],"restartsRemaining":v["restartsRemaining"]}})
                        }
                    };
                    writer.event(
                        writer_kind,
                        Message::Text(serde_json::to_string(&envelope).unwrap().into()),
                    );
                }
                None => break,
            }
        }
        if last_received.elapsed() >= Duration::from_secs(20) && ping_sent.is_none() {
            writer.event(WriterKind::Control, Message::Ping(Vec::new().into()));
            ping_sent = Some(Instant::now())
        }
        if ping_sent.is_some_and(|t| t.elapsed() >= Duration::from_millis(MAX_PONG_WAIT_MS)) {
            writer.close(
                tungstenite::protocol::frame::coding::CloseCode::Away,
                "Client idle",
            );
            break;
        }
        if last_received.elapsed() >= Duration::from_millis(MAX_IDLE_MS) {
            writer.close(
                tungstenite::protocol::frame::coding::CloseCode::Away,
                "Client idle",
            );
            break;
        }
        match ws.read() {
            Ok(Message::Text(text)) => {
                last_received = Instant::now();
                ping_sent = None;
                if writer.reserve().is_err() {
                    writer.close(
                        tungstenite::protocol::frame::coding::CloseCode::Again,
                        "Client too slow",
                    );
                    break;
                }
                let bytes = core.process(&cap_id, socket_id, text.as_bytes(), Some(&session));
                if !writer.complete(Message::Text(
                    String::from_utf8_lossy(&bytes).into_owned().into(),
                )) {
                    break;
                }
            }
            Ok(Message::Ping(v)) => {
                last_received = Instant::now();
                writer.event(WriterKind::Control, Message::Pong(v));
            }
            Ok(Message::Pong(_)) => {
                last_received = Instant::now();
                ping_sent = None;
            }
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {
                writer.close(
                    tungstenite::protocol::frame::coding::CloseCode::Policy,
                    "Protocol violation",
                );
                break;
            }
        }
    }
    writer.shutdown();
    auth.unregister_client(socket_id);
}

fn websocket_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(MAX_WS_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_WS_MESSAGE_BYTES))
        .read_buffer_size(MAX_WS_MESSAGE_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Barrier,
        },
        thread,
    };

    fn node20_executable() -> Option<PathBuf> {
        let mut candidates = vec![PathBuf::from(r"C:\nvm4w\nodejs\node.exe")];
        for variable in ["NVM_SYMLINK", "NVM_HOME"] {
            if let Some(path) = std::env::var_os(variable) {
                candidates.push(PathBuf::from(path).join("node.exe"));
            }
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            candidates.push(local.join("nvm/v20.20.2/node.exe"));
            candidates.push(local.join("Programs/nodejs/node.exe"));
        }
        if let Some(program_files) = std::env::var_os("ProgramFiles").map(PathBuf::from) {
            candidates.push(program_files.join("nodejs/node.exe"));
        }
        if let Some(paths) = std::env::var_os("PATH") {
            candidates.extend(std::env::split_paths(&paths).map(|path| path.join("node.exe")));
        }
        candidates.into_iter().find(|candidate| {
            candidate.is_file()
                && std::process::Command::new(candidate)
                    .arg("--version")
                    .output()
                    .ok()
                    .is_some_and(|output| {
                        output.status.success()
                            && String::from_utf8_lossy(&output.stdout)
                                .trim_start()
                                .starts_with("v20.")
                    })
        })
    }

    fn fixture() -> (
        std::path::PathBuf,
        Arc<ConfigStore>,
        Arc<AtomicUsize>,
        Arc<ProtocolCore>,
    ) {
        let root = std::env::temp_dir().join(format!(
            "gauge-sync-{}-{}",
            std::process::id(),
            random_id(6)
        ));
        let store = Arc::new(ConfigStore::new(root.join("config.json")));
        store.save(json!({"ingestToken":"SENTINEL-SECRET","future":{"kept":true},"serverUrl":"https://user:SENTINEL-SECRET@example.test/path?q=SENTINEL-SECRET","nodePath":"C:\\private\\node.exe"})).unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let core = Arc::new(ProtocolCore::mocked(
            store.clone(),
            Arc::new(move |_| {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }),
        ));
        (root, store, calls, core)
    }
    fn req(id: &str, kind: &str, body: Value) -> Vec<u8> {
        serde_json::to_vec(&json!({"v":1,"type":kind,"requestId":id,"body":body})).unwrap()
    }

    #[test]
    fn loopback_origin_and_upgrade_are_exact() {
        let listener = bind_loopback(0).unwrap();
        assert_eq!(
            listener.local_addr().unwrap().ip(),
            IpAddr::V4(Ipv4Addr::LOCALHOST)
        );
        let allowed: &[(&str, &str, Option<u16>)] = &[("coui", "html_ui", None)];
        assert_eq!(
            validate_upgrade(
                "127.0.0.1:2".parse().unwrap(),
                PATH,
                &["127.0.0.1:39091"],
                &["coui://html_ui"],
                false,
                39091,
                allowed
            ),
            101
        );
        for origin in [
            "null",
            "*",
            "file:///x",
            "http://localhost",
            "http://127.0.0.1",
            "http://127.0.0.1:39091",
            "coui://html_ui:443",
            "coui://other_ui",
            "coui://html_ui/?x=1",
        ] {
            assert_eq!(
                validate_upgrade(
                    "127.0.0.1:2".parse().unwrap(),
                    PATH,
                    &["127.0.0.1:39091"],
                    &[origin],
                    false,
                    39091,
                    allowed
                ),
                403
            );
        }
        assert_eq!(
            validate_upgrade(
                "10.0.0.2:2".parse().unwrap(),
                PATH,
                &["127.0.0.1:39091"],
                &["coui://html_ui"],
                false,
                39091,
                allowed
            ),
            403
        );
        assert_eq!(ALLOWED_GAUGE_ORIGINS, &[("coui", "html_ui", None)]);
        assert!(origin_allowed("coui://html_ui", ALLOWED_GAUGE_ORIGINS));
        for origin in [
            "null",
            "file:///x",
            "http://localhost",
            "https://localhost",
            "coui://html_ui:443",
        ] {
            assert!(!origin_allowed(origin, ALLOWED_GAUGE_ORIGINS));
        }
    }

    #[test]
    fn every_frozen_bound_is_present_and_queue_65_closes_before_work() {
        assert_eq!(
            (
                MAX_CLIENTS,
                MAX_HTTP_HEADER_BYTES,
                MAX_WS_MESSAGE_BYTES,
                MAX_INBOUND_IN_FLIGHT
            ),
            (4, 8192, 32768, 1)
        );
        assert_eq!(
            (
                MAX_REQUESTS_PER_10S,
                MAX_COMMANDS_PER_10S,
                MAX_PAIR_ATTEMPTS_PER_60S
            ),
            (20, 6, 5)
        );
        assert_eq!(
            (
                MAX_INBOUND_IN_FLIGHT,
                MAX_OUTBOUND_QUEUE,
                MAX_LOG_MESSAGE_BYTES,
                MAX_ERROR_MESSAGE_BYTES
            ),
            (1, 64, 2048, 256)
        );
        assert_eq!(
            (
                MAX_JSON_DEPTH,
                MAX_OBJECT_KEYS,
                MAX_ARRAY_ITEMS,
                MAX_STRING_BYTES,
                MAX_REQUEST_ID_BYTES
            ),
            (16, 64, 128, 4096, 64)
        );
        assert_eq!(
            (
                MAX_DEDUP_ENTRIES,
                MAX_DEDUP_AGE_MS,
                MAX_PAIR_CODE_AGE_MS,
                MAX_AUTH_DEADLINE_MS
            ),
            (1024, 600000, 120000, 5000)
        );
        assert_eq!(
            (
                MAX_IDLE_MS,
                MAX_PONG_WAIT_MS,
                MAX_COMMAND_RESULT_WAIT_MS,
                MAX_CONFIG_RESULT_WAIT_MS
            ),
            (30000, 10000, 5000, 10000)
        );
        let (_, _, calls, core) = fixture();
        let mut q = OutboundQueue::default();
        for n in 0..64 {
            let id = format!("REQUEST_{n:08}_XXXX");
            core.authorized_request("cap", 1, &req(&id, "uplink.start", json!({})), &mut q)
                .unwrap();
        }
        assert_eq!(q.occupancy(), 64);
        let before = calls.load(Ordering::SeqCst);
        assert_eq!(
            core.authorized_request(
                "cap",
                1,
                &req("REQUEST_00000064_XXXX", "uplink.start", json!({})),
                &mut q
            ),
            Err(Close {
                code: 1013,
                reason: "Client too slow"
            })
        );
        assert_eq!(calls.load(Ordering::SeqCst), before);
        let config = websocket_config();
        assert_eq!(config.max_frame_size, Some(MAX_WS_MESSAGE_BYTES));
        assert_eq!(config.max_message_size, Some(MAX_WS_MESSAGE_BYTES));
        assert!(client_slot_available(MAX_CLIENTS - 1));
        assert!(!client_slot_available(MAX_CLIENTS));
    }

    #[test]
    fn concurrent_duplicate_commands_enqueue_once_and_replay_identically() {
        let (root, _, calls, core) = fixture();
        let barrier = Arc::new(Barrier::new(9));
        let mut joins = vec![];
        for _ in 0..8 {
            let c = core.clone();
            let b = barrier.clone();
            joins.push(thread::spawn(move || {
                let mut q = OutboundQueue::default();
                b.wait();
                c.authorized_request(
                    "cap",
                    1,
                    &req("CONCURRENT_ID_0001", "sidecar.restart", json!({})),
                    &mut q,
                )
                .unwrap()
            }));
        }
        barrier.wait();
        let values: Vec<_> = joins.into_iter().map(|j| j.join().unwrap()).collect();
        assert!(values.windows(2).all(|w| w[0].as_ref() == w[1].as_ref()));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn config_merge_omission_and_recursive_projection_never_leak() {
        let (root, store, calls, core) = fixture();
        let before = fs::read_to_string(&store.path).unwrap();
        let mut q = OutboundQueue::default();
        let result = core
            .authorized_request(
                "cap",
                1,
                &req(
                    "CONFIG_PATCH_0001",
                    "config.patch",
                    json!({"patch":{"sim":"2024"}}),
                ),
                &mut q,
            )
            .unwrap();
        let after = fs::read_to_string(&store.path).unwrap();
        assert!(
            before.contains("SENTINEL-SECRET")
                && after.contains("SENTINEL-SECRET")
                && after.contains("\"kept\": true")
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let nested = json!({"v":1,"type":"status","path":"C:\\private","app":{"state":"SENTINEL-SECRET","argv":["C:\\private"]},"sim":{"lastError":"escaped SENTINEL-SECRET"},"configPath":"C:\\private\\config.json"});
        let projected = project_status(Some(&nested), &store);
        let combined = format!(
            "{:?} {:?} {:?}",
            result,
            projected,
            gauge_config(&store).unwrap()
        );
        for denied in [
            "SENTINEL-SECRET",
            "ingestToken",
            "configPath",
            "nodePath",
            "C:\\private",
        ] {
            assert!(!combined.contains(denied), "leaked {denied}");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sparse_sidecar_and_shell_statuses_project_to_the_complete_gauge_schema() {
        let (root, store, _calls, _core) = fixture();
        let keys = |v: &Value| {
            let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
            k.sort();
            k
        };
        let sorted = |names: &[&str]| {
            let mut k: Vec<String> = names.iter().map(|s| s.to_string()).collect();
            k.sort();
            k
        };
        // Captured from the real sidecar, plus the shell's synthetic status and a
        // config-problem status whose fields the gauge does not know.
        let sidecar = json!({"v":1,"type":"status","at":1789502822208u64,"app":{"state":"app.stopped"},"sim":{"state":"sim.idle","attempt":0,"nextRetryAt":null,"retryDelayMs":null,"protocol":"KittyHawk","appName":null,"appVersion":null,"lastError":null},"backend":{"state":"net.idle","httpStatus":null,"lastOkAt":null,"lastErrorAt":null,"message":null},"pause":{"state":"pause.off","flags":0,"label":"off","usingPauseEx1":false},"traffic":{"enabled":true,"radiusM":80000,"lastSweepAt":null,"lastBatchSize":null,"lastError":null},"config":{"version":1,"serverUrl":"https://192.168.0.30:3000","certPath":"C:\\private\\cert.pem","trafficEnabled":true,"trafficRadiusM":80000,"sim":"2020","autoUplink":false,"nodePath":null,"tokenSet":true}});
        let problems = json!({"v":1,"type":"status","app":{"state":"app.error-config","problems":[{"field":"*","message":"Config must be a JSON object"},{"field":"certPath","message":"missing"},{"field":"serverUrl","message":"bad"}]}});
        for status in [
            sidecar,
            crate::protocol::idle_status("app.starting"),
            problems,
        ] {
            let p = project_status(Some(&status), &store);
            assert_eq!(
                keys(&p),
                sorted(&["v", "type", "at", "app", "sim", "backend", "pause", "traffic", "config"])
            );
            assert_eq!(
                keys(&p["app"]),
                sorted(&[
                    "state",
                    "running",
                    "problems",
                    "restarting",
                    "restartsRemaining"
                ])
            );
            assert_eq!(
                keys(&p["sim"]),
                sorted(&[
                    "state",
                    "attempt",
                    "nextRetryAt",
                    "retryDelayMs",
                    "protocol",
                    "appName",
                    "appVersion",
                    "lastError"
                ])
            );
            assert_eq!(
                keys(&p["backend"]),
                sorted(&["state", "httpStatus", "lastOkAt", "lastErrorAt", "message"])
            );
            assert_eq!(
                keys(&p["pause"]),
                sorted(&["state", "flags", "label", "usingPauseEx1"])
            );
            assert_eq!(
                keys(&p["traffic"]),
                sorted(&[
                    "enabled",
                    "radiusM",
                    "lastSweepAt",
                    "lastBatchSize",
                    "lastError"
                ])
            );
            assert!(p["sim"]["appName"].is_string() && p["sim"]["protocol"].is_string());
            assert!(p["app"]["running"].is_boolean());
            assert!(p["app"]["restartsRemaining"]
                .as_u64()
                .is_some_and(|n| n <= 5));
            for problem in p["app"]["problems"].as_array().unwrap() {
                assert_eq!(keys(problem), sorted(&["field", "code", "message"]));
            }
            assert!(!p.to_string().contains("C:\\\\private"));
        }
        let p = project_status(
            Some(
                &json!({"app":{"state":"app.error-config","problems":[{"field":"*","message":"x"},{"field":"certPath","message":"y"},{"field":"serverUrl","message":"z"}]}}),
            ),
            &store,
        );
        let fields: Vec<&str> = p["app"]["problems"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["field"].as_str().unwrap())
            .collect();
        assert_eq!(fields, ["general", "general", "serverUrl"]);
        assert_eq!(p["app"]["running"], false);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn schema_version_type_depth_and_patch_bounds_reject_without_effect() {
        let (root, _, calls, core) = fixture();
        let bad = vec![
            req("SHORT", "uplink.start", json!({})),
            req(
                "VALID_REQUEST_0001",
                "config.patch",
                json!({"patch":{"trafficRadiusM":999}}),
            ),
            req("VALID_REQUEST_0002", "unknown", json!({})),
        ];
        for bytes in bad {
            let mut q = OutboundQueue::default();
            let response = core.authorized_request("cap", 1, &bytes, &mut q).unwrap();
            assert!(String::from_utf8_lossy(&response).contains("error"));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reassembled_message_boundary_is_exact() {
        let (root, _, calls, core) = fixture();
        let mut exact = req("MESSAGE_BOUNDARY_01", "uplink.start", json!({}));
        exact.resize(MAX_WS_MESSAGE_BYTES, b' ');
        let mut q = OutboundQueue::default();
        let accepted = core
            .authorized_request("boundary-cap", 1, &exact, &mut q)
            .unwrap();
        assert!(String::from_utf8_lossy(&accepted).contains("command.result"));
        let mut too_large = exact;
        too_large.push(b' ');
        let mut q2 = OutboundQueue::default();
        let rejected = core
            .authorized_request("boundary-cap", 1, &too_large, &mut q2)
            .unwrap();
        assert!(String::from_utf8_lossy(&rejected).contains("invalid_request"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pairing_persists_authorizes_and_revocation_is_immediate() {
        let root = std::env::temp_dir().join(format!(
            "gauge-auth-{}-{}",
            std::process::id(),
            random_id(5)
        ));
        let path = root.join("permissions.json");
        let auth = Authorization::load(path.clone());
        let epoch = auth.epoch();
        let started = auth.begin_pairing(false);
        let code = started["code"].as_str().unwrap();
        let (cap, id) = auth.pair(code).unwrap();
        assert_eq!(cap.len(), 43);
        assert_eq!(auth.authorize(&cap).as_deref(), Some(id.as_str()));
        assert!(auth.pair(&code).is_none());
        assert!(auth.epoch() > epoch);
        let loaded = Authorization::load(path);
        assert_eq!(loaded.authorize(&cap).as_deref(), Some(id.as_str()));
        let active = loaded.epoch();
        loaded.revoke().unwrap();
        assert!(loaded.epoch() > active);
        assert!(loaded.authorize(&cap).is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn capability_rates_are_exact_and_duplicate_replay_does_not_consume_rate() {
        let (root, _, calls, core) = fixture();
        for n in 0..MAX_COMMANDS_PER_10S {
            let id = format!("RATE_COMMAND_{n:04}_X");
            let mut q = OutboundQueue::default();
            let first = core
                .authorized_request("rate-cap", 1, &req(&id, "uplink.start", json!({})), &mut q)
                .unwrap();
            let mut replay_q = OutboundQueue::default();
            let replay = core
                .authorized_request(
                    "rate-cap",
                    1,
                    &req(&id, "uplink.start", json!({})),
                    &mut replay_q,
                )
                .unwrap();
            assert_eq!(first.as_ref(), replay.as_ref())
        }
        let mut q = OutboundQueue::default();
        let denied = core
            .authorized_request(
                "rate-cap",
                1,
                &req("RATE_COMMAND_9999_X", "uplink.start", json!({})),
                &mut q,
            )
            .unwrap();
        assert!(String::from_utf8_lossy(&denied).contains("rate_limited"));
        assert_eq!(calls.load(Ordering::SeqCst), MAX_COMMANDS_PER_10S);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn event_hub_is_bounded_and_fans_out() {
        let hub = GaugeEventHub::default();
        let a = hub.subscribe();
        let b = hub.subscribe();
        let event = Event::Log(json!({"message":"ok"}));
        hub.publish(event);
        assert!(matches!(a.pop(), Some(Event::Log(_))));
        assert!(matches!(b.pop(), Some(Event::Log(_))));
    }

    #[test]
    #[ignore = "diagnostic: runs the real sidecar and a Node 20 gauge probe"]
    fn live_supervisor_sidecar_stack_keeps_gauge_synchronized() {
        use crate::supervisor::Supervisor;
        use std::{
            io::Write,
            process::{Command, Stdio},
        };

        static ALLOWED: &[(&str, &str, Option<u16>)] = &[("http", "gauge.test", Some(80))];
        let node = node20_executable().expect("Node 20 executable is required");
        let root = std::env::temp_dir().join(format!("gauge-live-stack-{}", random_id(6)));
        fs::create_dir_all(&root).unwrap();
        let store = ConfigStore::new(root.join("config.json"));
        // Never the user's config: a dummy token, a closed local port, uplink off.
        store
            .save(json!({"version":1,"serverUrl":"http://127.0.0.1:9","ingestToken":"LOCAL-DIAGNOSTIC-TOKEN","sim":"2020","autoUplink":false,"trafficEnabled":true,"trafficRadiusM":80000,"nodePath":node}))
            .unwrap();
        let hub = Arc::new(GaugeEventHub::default());
        let sink_hub = hub.clone();
        let supervisor = Supervisor::new(
            store,
            None,
            Arc::new(move |event: Event| sink_hub.publish(event)),
        )
        .unwrap();
        let core = Arc::new(ProtocolCore::new(
            supervisor.config.clone(),
            supervisor.clone(),
        ));
        let service = GaugeService::start_test_on(core, hub, ALLOWED, 0).unwrap();
        let code = service.authorization.begin_pairing(false)["code"]
            .as_str()
            .unwrap()
            .to_owned();
        let probe = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("gauge/msfs/tools/live-stack-probe.mjs");
        let mut child = Command::new(&node)
            .arg(&probe)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("launch live stack probe");
        let request = json!({"endpoint":format!("ws://127.0.0.1:{}{}", service.port, PATH),"origin":"http://gauge.test","code":code,"seconds":45});
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(&request).unwrap())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        println!(
            "desktop status projected for gauge: {}",
            project_status(
                crate::config::lock(&supervisor.snapshot).status.as_ref(),
                &supervisor.config
            )
        );
        println!("probe stdout: {}", String::from_utf8_lossy(&output.stdout));
        println!("probe stderr: {}", String::from_utf8_lossy(&output.stderr));
        service.shutdown();
        supervisor.shutdown();
        let _ = fs::remove_dir_all(&root);
        assert!(output.status.success());
    }

    #[test]
    fn simulator_style_delayed_upgrade_is_accepted_and_awaits_auth() {
        use std::io::{Read, Write};

        static ALLOWED: &[(&str, &str, Option<u16>)] = &[("coui", "html_ui", None)];
        let (_root, _store, _calls, core) = fixture();
        let service =
            GaugeService::start_test_on(core, Arc::new(GaugeEventHub::default()), ALLOWED, 0)
                .unwrap();
        let port = service.port;
        let mut stream = std::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        // Coherent GT connects first and sends its upgrade request afterwards.
        thread::sleep(Duration::from_millis(300));
        let request = format!(
            "GET {PATH} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: coui://html_ui\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            assert_eq!(
                stream.read(&mut byte).unwrap(),
                1,
                "server closed during upgrade"
            );
            head.push(byte[0]);
        }
        assert!(head.starts_with(b"HTTP/1.1 101"));
        // The auth deadline must be a real wait, not an immediate would-block close.
        stream
            .set_read_timeout(Some(Duration::from_millis(500)))
            .unwrap();
        match stream.read(&mut byte) {
            Err(e) => assert!(matches!(
                e.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
            )),
            Ok(n) => panic!("server sent {n} bytes or closed before the auth deadline"),
        }
        drop(stream);
        service.shutdown();
    }

    #[test]
    fn live_ephemeral_loopback_pair_and_mock_operation() {
        use tungstenite::client::IntoClientRequest;

        static ALLOWED: &[(&str, &str, Option<u16>)] = &[("http", "gauge.test", Some(80))];
        let (root, _store, calls, core) = fixture();
        let permission = root.join("gauge-permissions.json");
        let auth = Arc::new(Authorization::load(permission));
        let pairing = auth.begin_pairing(false);
        let code = pairing["code"].as_str().unwrap().to_owned();
        let listener = bind_loopback(0).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server_auth = auth.clone();
        let server_core = core.clone();
        let server = thread::spawn(move || {
            let (stream, peer) = listener.accept().unwrap();
            serve(
                stream,
                peer,
                port,
                ALLOWED,
                server_auth,
                server_core,
                Arc::new(EventMailbox::default()),
                Arc::new(random_id(16)),
                Arc::new(AtomicU64::new(0)),
                None,
            );
        });
        let stream = std::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        let mut request = format!("ws://127.0.0.1:{port}{PATH}")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("Origin", "http://gauge.test".parse().unwrap());
        let (mut client, response) = tungstenite::client(request, stream).unwrap();
        assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
        client
            .send(Message::Text(
                serde_json::to_string(&json!({"v":1,"type":"pair.request","requestId":"LIVE_PAIR_REQUEST","body":{"code":code,"clientLabel":"MSFS CDU"}}))
                    .unwrap()
                    .into(),
            ))
            .unwrap();
        let mut initial_full = None;
        for expected in ["pair.result", "session.welcome", "state.full"] {
            let Message::Text(text) = client.read().unwrap() else {
                panic!("text response required")
            };
            let value = serde_json::from_str::<Value>(&text).unwrap();
            assert_eq!(value["type"], expected);
            if expected == "state.full" {
                initial_full = Some(value);
            }
        }
        client
            .send(Message::Text(
                String::from_utf8(req("LIVE_COMMAND_REQ", "uplink.start", json!({})))
                    .unwrap()
                    .into(),
            ))
            .unwrap();
        let Message::Text(text) = client.read().unwrap() else {
            panic!("text response required")
        };
        assert_eq!(
            serde_json::from_str::<Value>(&text).unwrap()["type"],
            "command.result"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        client
            .send(Message::Text(
                String::from_utf8(req("LIVE_STATE_GET_X", "state.get", json!({})))
                    .unwrap()
                    .into(),
            ))
            .unwrap();
        let Message::Text(text) = client.read().unwrap() else {
            panic!("text response required")
        };
        let replay = serde_json::from_str::<Value>(&text).unwrap();
        let initial = initial_full.unwrap();
        assert_eq!(replay["type"], "state.full");
        for key in [
            "serviceInstanceId",
            "connectionId",
            "snapshotSeq",
            "eventSeq",
            "generatedAt",
            "config",
            "status",
        ] {
            assert!(replay["body"].get(key).is_some(), "missing {key}");
        }
        assert_eq!(
            replay["body"]["serviceInstanceId"],
            initial["body"]["serviceInstanceId"]
        );
        assert_eq!(
            replay["body"]["connectionId"],
            initial["body"]["connectionId"]
        );
        assert!(replay["body"]["snapshotSeq"].as_u64() > initial["body"]["snapshotSeq"].as_u64());
        assert_eq!(replay["body"]["config"], initial["body"]["config"]);
        client.close(None).unwrap();
        server.join().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_confirmation_matrix_and_atomic_failure_preserve_state() {
        let root = std::env::temp_dir().join(format!("gauge-corrupt-matrix-{}", random_id(6)));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("permissions.json");

        let missing = Authorization::load(path.clone());
        assert_eq!(
            normalize_confirm_corrupt(None),
            normalize_confirm_corrupt(Some(false))
        );
        assert_eq!(missing.begin_pairing(true)["code"], "invalid_confirmation");
        assert_eq!(missing.begin_pairing(false)["ok"], true);
        assert!(!path.exists());
        let unreadable = Authorization::from_read(
            path.clone(),
            Err(io::Error::new(io::ErrorKind::PermissionDenied, "injected")),
        );
        assert_eq!(
            unreadable.begin_pairing(false)["code"],
            "confirmation_required"
        );
        assert!(!path.exists());

        let epoch = random_id(16);
        fs::write(&path, serde_json::to_vec(&json!({"v":1,"capabilityEpoch":epoch,"capabilityId":null,"salt":null,"verifier":null,"created":null,"lastUsed":null})).unwrap()).unwrap();
        let before = fs::read(&path).unwrap();
        let unpaired = Authorization::load(path.clone());
        assert_eq!(unpaired.begin_pairing(true)["code"], "invalid_confirmation");
        let issued = unpaired.begin_pairing(false);
        assert_eq!(issued["ok"], true);
        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(unpaired.pair(issued["code"].as_str().unwrap()).is_some());
        #[cfg(windows)]
        assert_user_only_protected_dacl(&path);
        let paired_bytes = fs::read(&path).unwrap();
        assert_eq!(unpaired.begin_pairing(true)["code"], "invalid_confirmation");
        assert_eq!(unpaired.begin_pairing(false)["ok"], true);
        assert_eq!(fs::read(&path).unwrap(), paired_bytes);

        fs::write(&path, b"{corrupt").unwrap();
        let corrupt = Authorization::load(path.clone());
        let (_, _, _, recovery_core) = fixture();
        recovery_core.rates.lock().unwrap().insert(
            "old-cap".into(),
            (VecDeque::from([Instant::now()]), VecDeque::new()),
        );
        recovery_core.dedup.lock().unwrap().insert(
            ("old-cap".into(), "OLD_REQUEST_ID_X".into()),
            DedupEntry::Terminal(Terminal {
                hash: [1; 32],
                response: encode(json!({"old":true})),
                completed: Instant::now(),
            }),
        );
        let cleared = recovery_core.clone();
        corrupt.set_invalidate(Arc::new(move || {
            cleared.rates.lock().unwrap().clear();
            cleared.dedup.lock().unwrap().clear();
        }));
        let revoked = corrupt.register_client(777);
        corrupt.attempts.lock().unwrap().push_back(Instant::now());
        assert_eq!(
            corrupt.begin_pairing(false)["code"],
            "confirmation_required"
        );
        assert_eq!(fs::read(&path).unwrap(), b"{corrupt");
        corrupt.fail_before_replace.store(true, Ordering::Release);
        let metadata = fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(corrupt.begin_pairing(true)["code"], "internal");
        assert_eq!(fs::read(&path).unwrap(), b"{corrupt");
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), metadata);
        assert!(corrupt.corrupt.load(Ordering::Acquire));
        assert_eq!(recovery_core.dedup.lock().unwrap().len(), 1);
        assert_eq!(recovery_core.rates.lock().unwrap().len(), 1);
        assert!(revoked.try_recv().is_err());
        corrupt.fail_before_replace.store(false, Ordering::Release);
        let recovered = corrupt.begin_pairing(true);
        assert_eq!(recovered["ok"], true);
        assert!(revoked.recv_timeout(Duration::from_millis(100)).is_ok());
        assert!(recovery_core.dedup.lock().unwrap().is_empty());
        assert!(recovery_core.rates.lock().unwrap().is_empty());
        assert!(corrupt.attempts.lock().unwrap().is_empty());
        assert!(corrupt.pair.lock().unwrap().is_some());
        let record: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(exact_keys(
            record.as_object().unwrap(),
            &[
                "v",
                "capabilityEpoch",
                "capabilityId",
                "salt",
                "verifier",
                "created",
                "lastUsed"
            ]
        ));
        assert_ne!(record["capabilityEpoch"], epoch);
        assert!(["capabilityId", "salt", "verifier", "created", "lastUsed"]
            .iter()
            .all(|key| record[*key].is_null()));
        assert!(corrupt.authorize(&random_id(32)).is_none());
        assert_eq!(corrupt.begin_pairing(true)["code"], "invalid_confirmation");

        fs::write(&path, serde_json::to_vec(&json!({"v":1,"capabilityEpoch":random_id(16),"capabilityId":"bad","salt":"bad","verifier":"bad","created":0,"lastUsed":0})).unwrap()).unwrap();
        let invalid_fields = Authorization::load(path.clone());
        assert_eq!(
            invalid_fields.begin_pairing(false)["code"],
            "confirmation_required"
        );
        assert_eq!(invalid_fields.begin_pairing(true)["ok"], true);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn timed_out_effect_is_an_immutable_terminal_replay() {
        let root = std::env::temp_dir().join(format!("gauge-timeout-{}", random_id(6)));
        fs::create_dir_all(&root).unwrap();
        let store = Arc::new(ConfigStore::new(root.join("config.json")));
        let calls = Arc::new(AtomicUsize::new(0));
        let called = calls.clone();
        let core = Arc::new(ProtocolCore::mocked(
            store,
            Arc::new(move |_| {
                called.fetch_add(1, Ordering::SeqCst);
                thread::sleep(Duration::from_millis(MAX_COMMAND_RESULT_WAIT_MS + 200));
                Ok(())
            }),
        ));
        let request = req("TIMEOUT_REQUEST_X", "uplink.start", json!({}));
        let mut first_queue = OutboundQueue::default();
        let first = core
            .authorized_request("cap", 1, &request, &mut first_queue)
            .unwrap();
        assert!(String::from_utf8_lossy(&first).contains("timeout"));
        thread::sleep(Duration::from_millis(300));
        let mut replay_queue = OutboundQueue::default();
        let replay = core
            .authorized_request("cap", 2, &request, &mut replay_queue)
            .unwrap();
        assert_eq!(first.as_ref(), replay.as_ref());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn live_blocked_socket_writer_rejects_before_effect_at_64() {
        let listener = bind_loopback(0).unwrap();
        let port = listener.local_addr().unwrap().port();
        let peer = std::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        let (server, _) = listener.accept().unwrap();
        let writer = SocketWriter::start(server, None);
        let payload = "x".repeat(MAX_WS_MESSAGE_BYTES);
        let effects = AtomicUsize::new(0);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match writer.reserve() {
                Ok(()) => {
                    effects.fetch_add(1, Ordering::SeqCst);
                    assert!(writer.complete(Message::Text(payload.clone().into())));
                }
                Err(close) => {
                    assert_eq!(
                        close,
                        Close {
                            code: 1013,
                            reason: "Client too slow"
                        }
                    );
                    assert_eq!(writer.occupancy(), MAX_OUTBOUND_QUEUE);
                    let before_65 = effects.load(Ordering::SeqCst);
                    assert!(writer.reserve().is_err());
                    assert_eq!(effects.load(Ordering::SeqCst), before_65);
                    break;
                }
            }
            assert!(
                Instant::now() < deadline,
                "writer did not encounter blocked-peer backpressure"
            );
        }
        let stopped = Instant::now();
        writer.shutdown();
        assert!(writer.is_closed());
        assert!(stopped.elapsed() < Duration::from_secs(1));
        drop(peer);
    }

    #[test]
    fn integrated_slow_websocket_64_65_shutdown_and_replay() {
        use tungstenite::client::IntoClientRequest;
        static ALLOWED: &[(&str, &str, Option<u16>)] = &[("http", "gauge.test", Some(80))];
        let (root, _, calls, core) = fixture();
        let auth = Arc::new(Authorization::load(root.join("permissions.json")));
        let issued = auth.begin_pairing(false);
        let (capability, capability_id) = auth.pair(issued["code"].as_str().unwrap()).unwrap();
        let pause = Arc::new(AtomicBool::new(false));
        let listener = bind_loopback(0).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server_auth = auth.clone();
        let server_core = core.clone();
        let server_pause = pause.clone();
        let server = thread::spawn(move || {
            let (stream, peer) = listener.accept().unwrap();
            serve(
                stream,
                peer,
                port,
                ALLOWED,
                server_auth,
                server_core,
                Arc::new(EventMailbox::default()),
                Arc::new(random_id(16)),
                Arc::new(AtomicU64::new(0)),
                Some(server_pause),
            );
        });
        let stream = std::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        let mut request = format!("ws://127.0.0.1:{port}{PATH}")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("Origin", "http://gauge.test".parse().unwrap());
        let (mut client, _) = tungstenite::client(request, stream).unwrap();
        client.send(Message::Text(serde_json::to_string(&json!({"v":1,"type":"auth.request","requestId":"SLOW_AUTH_REQUEST","body":{"capability":capability}})).unwrap().into())).unwrap();
        for _ in 0..3 {
            assert!(matches!(client.read().unwrap(), Message::Text(_)));
        }
        pause.store(true, Ordering::Release);
        for n in 0..=MAX_OUTBOUND_QUEUE {
            let id = format!("SLOW_REQUEST_{n:04}");
            client
                .send(Message::Text(
                    String::from_utf8(req(&id, "config.path.get", json!({})))
                        .unwrap()
                        .into(),
                ))
                .unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while core.requests_started.load(Ordering::Acquire) < MAX_OUTBOUND_QUEUE
            && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            core.requests_started.load(Ordering::Acquire),
            MAX_OUTBOUND_QUEUE
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let close = client.read().unwrap();
        let Message::Close(Some(frame)) = close else {
            panic!("priority close required, got {close:?}")
        };
        assert_eq!(
            frame.code,
            tungstenite::protocol::frame::coding::CloseCode::Again
        );
        assert_eq!(frame.reason, "Client too slow");
        server.join().unwrap();
        drop(client);

        let replay_request = req("SLOW_REQUEST_0000", "config.path.get", json!({}));
        let cached = match core
            .dedup
            .lock()
            .unwrap()
            .get(&(capability_id.clone(), "SLOW_REQUEST_0000".into()))
            .unwrap()
        {
            DedupEntry::Terminal(value) => value.response.clone(),
            DedupEntry::Pending(_) => panic!("request must be terminal"),
        };
        let mut queue = OutboundQueue::default();
        let before_replay = core.requests_started.load(Ordering::Acquire);
        let replay = core
            .authorized_request(&capability_id, 99, &replay_request, &mut queue)
            .unwrap();
        assert!(String::from_utf8_lossy(&replay).contains("config.path.result"));
        assert_eq!(replay.as_ref(), cached.as_ref());
        assert_eq!(
            core.requests_started.load(Ordering::Acquire),
            before_replay + 1
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "requires an installed Node 20 runtime"]
    fn real_node20_gauge_adapter_ephemeral_websocket_e2e() {
        use std::{
            io::Write,
            process::{Command, Stdio},
        };
        static ALLOWED: &[(&str, &str, Option<u16>)] = &[("http", "gauge.test", Some(80))];
        let root = std::env::temp_dir().join(format!("gauge-node-e2e-{}", random_id(6)));
        fs::create_dir_all(&root).unwrap();
        let sentinel = "PRIVATE-SENTINEL-INGEST-TOKEN";
        let store = Arc::new(ConfigStore::new(root.join("config.json")));
        store.save(json!({"ingestToken":sentinel,"unknownFuture":{"preserved":true},"trafficEnabled":true,"trafficRadiusM":40000,"sim":"2020"})).unwrap();
        let counts = Arc::new(Mutex::new([0usize; 4]));
        let captured = counts.clone();
        let core = Arc::new(ProtocolCore::mocked(
            store.clone(),
            Arc::new(move |operation| {
                let index = match operation {
                    Operation::Start => 0,
                    Operation::Stop => 1,
                    Operation::Restart => 2,
                    Operation::Reload => 3,
                };
                captured.lock().unwrap()[index] += 1;
                Ok(())
            }),
        ));
        core.snapshot.lock().unwrap().status = Some(
            // The real sidecar's sparse shape: bare app state, null appName, extra config keys.
            json!({"v":1,"type":"status","at":now(),"app":{"state":"app.running"},"sim":{"state":"sim.connected","attempt":1,"nextRetryAt":null,"retryDelayMs":null,"protocol":"KittyHawk","appName":null,"appVersion":null,"lastError":null},"backend":{"state":"net.ok","httpStatus":200,"lastOkAt":now(),"lastErrorAt":null,"message":null},"pause":{"state":"active","flags":0,"label":"running","usingPauseEx1":true},"traffic":{"enabled":true,"radiusM":40000,"lastSweepAt":null,"lastBatchSize":0,"lastError":null},"config":{"version":1,"certPath":"C:\\private\\cert.pem","nodePath":null,"tokenSet":true}}),
        );
        let service =
            GaugeService::start_test(core.clone(), Arc::new(GaugeEventHub::default()), ALLOWED)
                .unwrap();
        let issued = service.authorization.begin_pairing(false);
        let (capability, _) = service
            .authorization
            .pair(issued["code"].as_str().unwrap())
            .unwrap();
        let node = node20_executable()
            .expect("Node 20 executable is required for the real WebSocket integration test");
        let driver = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("gauge/msfs/tools/real-websocket-e2e.mjs");
        TEST_SERVER_STAGE.store(0, Ordering::Release);
        TEST_FIRST_READ_OUTCOME.store(0, Ordering::Release);
        TEST_PEEK_AVAILABLE.store(0, Ordering::Release);
        *TEST_PEEK_META.lock().unwrap() = None;
        let mut child = Command::new(&node)
            .arg(&driver)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("launch Node 20 real websocket driver");
        let private = serde_json::to_vec(&json!({"endpoint":format!("ws://127.0.0.1:{}{}",service.port,PATH),"origin":"http://gauge.test","invalidOrigin":"http://invalid.test","capability":capability,"sentinel":sentinel,"patch":{"trafficEnabled":false,"trafficRadiusM":55000}})).unwrap();
        child.stdin.take().unwrap().write_all(&private).unwrap();
        let happy_deadline = Instant::now() + Duration::from_secs(10);
        while *counts.lock().unwrap() != [1, 1, 1, 1] && Instant::now() < happy_deadline {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            *counts.lock().unwrap(),
            [1, 1, 1, 1],
            "driver did not reach passive endpoint-restart wait"
        );
        let restart_port = service.port;
        service.shutdown();
        assert_eq!(service.active.load(Ordering::Acquire), 0);
        core.snapshot.lock().unwrap().status = Some(
            json!({"v":1,"type":"status","at":now(),"app":{"state":"app.running","running":true,"problems":[],"restarting":false,"restartsRemaining":5},"sim":{"state":"sim.connected","attempt":2,"nextRetryAt":null,"retryDelayMs":null,"protocol":"v1","appName":"MSFS","appVersion":"2","lastError":null},"backend":{"state":"net.ok","httpStatus":200,"lastOkAt":now(),"lastErrorAt":null,"message":null},"pause":{"state":"active","flags":1,"label":"restarted","usingPauseEx1":true},"traffic":{"enabled":false,"radiusM":55000,"lastSweepAt":null,"lastBatchSize":0,"lastError":null}}),
        );
        let replacement = GaugeService::start_test_on(
            core.clone(),
            Arc::new(GaugeEventHub::default()),
            ALLOWED,
            restart_port,
        )
        .unwrap();
        let output = child.wait_with_output().unwrap();
        replacement.shutdown();
        assert_eq!(replacement.active.load(Ordering::Acquire), 0);
        assert!(
            output.status.success(),
            "real driver failed with fixed stderr: {}; server_stage={}; first_read_outcome={}; peek_available={}; peek_frame={:?}; requests_started={}",
            String::from_utf8_lossy(&output.stderr),
            test_stage_name(),
            test_first_read_outcome_name(),
            TEST_PEEK_AVAILABLE.load(Ordering::Acquire),
            *TEST_PEEK_META.lock().unwrap(),
            core.requests_started.load(Ordering::Acquire)
        );
        let peek_available = TEST_PEEK_AVAILABLE.load(Ordering::Acquire);
        let peek = TEST_PEEK_META
            .lock()
            .unwrap()
            .expect("first frame structure must be available");
        assert_eq!((peek.0, peek.1, peek.2, peek.3), (true, 1, true, 126));
        assert!(peek.4 <= MAX_WS_MESSAGE_BYTES as u64);
        assert!(peek_available as u64 >= peek.4 + 8);
        println!(
            "e2e server_stage={} first_read_outcome={} peek_available={} fin={} opcode={} masked={} marker={} declared={} requests_started={}",
            test_stage_name(), test_first_read_outcome_name(), peek_available,
            peek.0, peek.1, peek.2, peek.3, peek.4,
            core.requests_started.load(Ordering::Acquire)
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).unwrap(),
            json!({"status":"PASS","stage":"COMPLETE","code":"OK","lastMilestone":"FRAME_WRITE_COMPLETED"})
        );
        assert!(!String::from_utf8_lossy(&output.stdout).contains(sentinel));
        assert!(!String::from_utf8_lossy(&output.stderr).contains(sentinel));
        let values = *counts.lock().unwrap();
        assert_eq!(&values[..3], &[1, 1, 1]);
        assert_eq!(values[3], 1);
        assert_eq!(core.requests_started.load(Ordering::Acquire), 31);
        let saved = fs::read_to_string(&store.path).unwrap();
        assert!(saved.contains(sentinel));
        let raw: Value = serde_json::from_str(&saved).unwrap();
        assert_eq!(raw["ingestToken"], sentinel);
        assert_eq!(raw["unknownFuture"]["preserved"], true);
        assert_eq!(raw["trafficEnabled"], false);
        assert_eq!(raw["trafficRadiusM"], 55000);
        fs::remove_dir_all(root).unwrap();
    }
}

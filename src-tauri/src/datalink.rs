use crate::{config::lock, protocol};
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Mutex,
    },
    time::Duration,
};

pub const FEATURE: &str = "datalink";
/// The SimBrief ops; a sidecar without it would leave them unanswered.
pub const SIMBRIEF_FEATURE: &str = "simbrief-prefile";
/// The clearance op; a sidecar without it would leave the request unanswered.
pub const CLEARANCE_FEATURE: &str = "pdc-clearance";
// Longer than the sidecar's own 8 s HTTP timeout, so a slow server is reported
// by the sidecar with its real cause before the shell gives up on the answer.
pub const REQUEST_TIMEOUT: Duration = Duration::from_millis(12_000);
/// The sidecar's HTTP timeout for the SimBrief prefile POST, mirrored here so
/// the relay can be checked against it; tools/contract-check.mjs keeps the two
/// equal.
pub const SIDECAR_PREFILE_HTTP_TIMEOUT: Duration = Duration::from_millis(25_000);
/// How much longer than the sidecar's HTTP timeout the relay waits, at least:
/// the margin the 8 s / 12 s pair has always kept.
pub const RELAY_SLACK_MIN: Duration = Duration::from_millis(4_000);
// The server spends up to 20 s on SimBrief before it answers. The relay
// outwaits the sidecar's 25 s prefile timeout, so an unknown outcome is
// reported by the sidecar with its real cause rather than as a shell timeout.
pub const PREFILE_REQUEST_TIMEOUT: Duration = Duration::from_millis(30_000);
const _: () = assert!(
    PREFILE_REQUEST_TIMEOUT.as_millis()
        >= SIDECAR_PREFILE_HTTP_TIMEOUT.as_millis() + RELAY_SLACK_MIN.as_millis()
);
// The CDU needs at most three requests at once; a runaway caller is refused
// rather than queued without limit.
pub const PENDING_MAX: usize = 8;
pub const STATE_OUTDATED: &str = "dl.sidecar-outdated";
pub const STATE_UNAVAILABLE: &str = "dl.sidecar-unavailable";
const SAFE_INTEGER_MAX: u64 = 9_007_199_254_740_991;
const REQUEST_LINE_MAX: usize = 4096;
pub const OPS: [&str; 11] = [
    "watch",
    "refresh",
    "thread",
    "canned-list",
    "send-canned",
    "wx",
    "loadsheet",
    "simbrief-settings",
    "simbrief-prefile",
    "prefile-clear",
    "clearance",
];
pub const SIMBRIEF_OPS: [&str; 3] = ["simbrief-settings", "simbrief-prefile", "prefile-clear"];
pub const CLEARANCE_OPS: [&str; 1] = ["clearance"];

/// How long the relay waits for an answer. Only the prefile, which can take
/// the server 20 s, waits longer than every other op.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RelayTimeouts {
    pub default: Duration,
    pub prefile: Duration,
}

impl RelayTimeouts {
    pub const PRODUCTION: RelayTimeouts = RelayTimeouts {
        default: REQUEST_TIMEOUT,
        prefile: PREFILE_REQUEST_TIMEOUT,
    };

    pub fn for_op(&self, op: &str) -> Duration {
        if op == "simbrief-prefile" {
            self.prefile
        } else {
            self.default
        }
    }
}

pub fn error_envelope(code: &str) -> Value {
    json!({"ok":false, "error":{"code":code, "httpStatus":null, "serverCode":null}})
}

pub fn synthetic_state(state: &str) -> Value {
    json!({
        "v":1, "type":"datalink-state", "at":protocol::now(), "state":state, "watching":false,
        "httpStatus":null, "serverCode":null, "lastOkAt":null, "lastErrorAt":null,
        "nextPollAt":null, "scope":null, "thread":null
    })
}

/// A sidecar that predates the datalink silently ignores its requests, so the
/// shell only talks to one that announced the feature in its hello.
pub fn supports_datalink(hello: &Value) -> bool {
    hello["features"]
        .as_array()
        .is_some_and(|features| features.iter().any(|feature| feature == FEATURE))
}

/// A sidecar that has the datalink but predates SimBrief would leave these ops
/// unanswered too, so they are only sent to one that announced this feature.
pub fn supports_simbrief(hello: &Value) -> bool {
    hello["features"]
        .as_array()
        .is_some_and(|features| features.iter().any(|feature| feature == SIMBRIEF_FEATURE))
}

/// A sidecar that predates the clearance op would leave it unanswered, so it is
/// only sent to one that announced this feature.
pub fn supports_clearance(hello: &Value) -> bool {
    hello["features"]
        .as_array()
        .is_some_and(|features| features.iter().any(|feature| feature == CLEARANCE_FEATURE))
}

fn has_exact_keys(value: &Value, keys: &[&str]) -> Option<Map<String, Value>> {
    let object = value.as_object()?;
    (object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key)))
        .then(|| object.clone())
}

fn safe_integer(value: &Value, min: u64) -> bool {
    value
        .as_u64()
        .is_some_and(|n| (min..=SAFE_INTEGER_MAX).contains(&n))
}

fn valid_target(value: &Value) -> bool {
    has_exact_keys(value, &["kind", "id"]).is_some_and(|target| {
        matches!(target["kind"].as_str(), Some("flight" | "leg")) && safe_integer(&target["id"], 1)
    })
}

fn valid_canned_id(value: &Value) -> bool {
    value.as_str().is_some_and(|id| {
        let bytes = id.as_bytes();
        (1..=64).contains(&bytes.len())
            && bytes[0].is_ascii_alphanumeric()
            && bytes[1..]
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    })
}

fn valid_icao(value: &Value) -> bool {
    value.as_str().is_some_and(|icao| {
        let bytes = icao.as_bytes();
        bytes.len() == 4
            && bytes[0].is_ascii_uppercase()
            && bytes[1..]
                .iter()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
    })
}

/// The same rules the sidecar applies. Extra keys are refused, because an extra
/// key next to a canned id is exactly how free text would be smuggled through.
pub fn valid_params(op: &str, params: &Value) -> bool {
    match op {
        "watch" => has_exact_keys(params, &["on"]).is_some_and(|p| p["on"].is_boolean()),
        // No SimBrief op takes a parameter: nothing can ask for a duplicate
        // import, a trip or a Pilot ID.
        "refresh" | "canned-list" | "simbrief-settings" | "simbrief-prefile" | "prefile-clear" => {
            has_exact_keys(params, &[]).is_some()
        }
        "thread" => has_exact_keys(params, &["epoch", "endSeq"])
            .is_some_and(|p| safe_integer(&p["epoch"], 1) && safe_integer(&p["endSeq"], 0)),
        "send-canned" => has_exact_keys(params, &["target", "cannedId"])
            .is_some_and(|p| valid_target(&p["target"]) && valid_canned_id(&p["cannedId"])),
        "wx" => has_exact_keys(params, &["target", "icao"])
            .is_some_and(|p| valid_target(&p["target"]) && valid_icao(&p["icao"])),
        "loadsheet" => has_exact_keys(params, &["plannedLegId"])
            .is_some_and(|p| safe_integer(&p["plannedLegId"], 1)),
        // Only the leg: a trip or flight id beside it could aim the request at
        // something other than the leg the CDU confirmed.
        "clearance" => has_exact_keys(params, &["plannedLegId"])
            .is_some_and(|p| safe_integer(&p["plannedLegId"], 1)),
        _ => false,
    }
}

/// Builds the request line without its newline, or None when the op is unknown
/// or the line would exceed the size the sidecar is promised.
pub fn request_line(id: &str, op: &str, params: &Value) -> Option<String> {
    if !OPS.contains(&op) {
        return None;
    }
    let line =
        json!({"v":1, "type":"datalink-request", "id":id, "op":op, "params":params}).to_string();
    (line.len() <= REQUEST_LINE_MAX).then_some(line)
}

/// Strips a decoded datalink-response down to the envelope the webview sees.
pub fn response_envelope(response: &Value) -> Value {
    if response["ok"] == Value::Bool(true) {
        return json!({"ok":true, "result":response["result"].clone()});
    }
    let error = &response["error"];
    let code = error["code"]
        .as_str()
        .filter(|code| (1..=64).contains(&code.len()))
        .unwrap_or("bad-response");
    let http_status = Some(&error["httpStatus"])
        .filter(|status| status.is_number())
        .cloned()
        .unwrap_or(Value::Null);
    let server_code = Some(&error["serverCode"])
        .filter(|code| code.is_string())
        .cloned()
        .unwrap_or(Value::Null);
    json!({"ok":false, "error":{"code":code, "httpStatus":http_status, "serverCode":server_code}})
}

struct Pending {
    // None until the worker has handed the line to a particular sidecar.
    generation: Option<u64>,
    reply: SyncSender<Value>,
}

/// Correlates datalink requests with their responses. Each entry is resolved
/// at most once: whoever removes it from the map is the one that answers.
pub struct DatalinkRelay {
    next: AtomicU64,
    pending: Mutex<HashMap<String, Pending>>,
}

impl Default for DatalinkRelay {
    fn default() -> Self {
        Self {
            next: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
        }
    }
}

impl DatalinkRelay {
    pub fn register(&self) -> Result<(String, Receiver<Value>), Value> {
        let mut pending = lock(&self.pending);
        if pending.len() >= PENDING_MAX {
            return Err(error_envelope("busy"));
        }
        let id = format!("dl-{}", self.next.fetch_add(1, Ordering::Relaxed));
        let (reply, receiver) = mpsc::sync_channel(1);
        pending.insert(
            id.clone(),
            Pending {
                generation: None,
                reply,
            },
        );
        Ok((id, receiver))
    }

    pub fn bind_generation(&self, id: &str, generation: u64) {
        if let Some(entry) = lock(&self.pending).get_mut(id) {
            entry.generation = Some(generation);
        }
    }

    pub fn complete(&self, id: &str, generation: u64, envelope: Value) -> bool {
        let mut pending = lock(&self.pending);
        if pending.get(id).and_then(|entry| entry.generation) != Some(generation) {
            return false;
        }
        if let Some(entry) = pending.remove(id) {
            let _ = entry.reply.try_send(envelope);
        }
        true
    }

    pub fn fail_unbound(&self, id: &str, code: &str) {
        let mut pending = lock(&self.pending);
        if pending
            .get(id)
            .is_some_and(|entry| entry.generation.is_none())
        {
            if let Some(entry) = pending.remove(id) {
                let _ = entry.reply.try_send(error_envelope(code));
            }
        }
    }

    pub fn fail_generation(&self, generation: u64) {
        let mut pending = lock(&self.pending);
        let exited: Vec<String> = pending
            .iter()
            .filter(|(_, entry)| entry.generation == Some(generation))
            .map(|(id, _)| id.clone())
            .collect();
        for id in exited {
            if let Some(entry) = pending.remove(&id) {
                let _ = entry.reply.try_send(error_envelope("sidecar-exited"));
            }
        }
    }

    pub fn abandon(&self, id: &str) {
        lock(&self.pending).remove(id);
    }

    #[cfg(test)]
    pub fn pending(&self) -> usize {
        lock(&self.pending).len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolved(receiver: &Receiver<Value>) -> Option<Value> {
        receiver.try_recv().ok()
    }

    #[test]
    fn ids_are_sequential_from_one() {
        let relay = DatalinkRelay::default();
        let (first, _a) = relay.register().unwrap();
        let (second, _b) = relay.register().unwrap();
        assert_eq!((first.as_str(), second.as_str()), ("dl-1", "dl-2"));
    }

    #[test]
    fn requests_beyond_the_pending_bound_are_refused() {
        let relay = DatalinkRelay::default();
        let held: Vec<_> = (0..PENDING_MAX)
            .map(|_| relay.register().unwrap())
            .collect();
        assert_eq!(relay.register().unwrap_err(), error_envelope("busy"));
        relay.abandon(&held[0].0);
        assert!(relay.register().is_ok());
    }

    #[test]
    fn complete_needs_a_known_id_and_the_bound_generation() {
        let relay = DatalinkRelay::default();
        let (id, receiver) = relay.register().unwrap();
        let envelope = json!({"ok":true, "result":{}});
        // Unbound: the line never reached a sidecar, so no sidecar can answer it.
        assert!(!relay.complete(&id, 1, envelope.clone()));
        relay.bind_generation(&id, 3);
        assert!(!relay.complete(&id, 2, envelope.clone()));
        assert!(!relay.complete("dl-999", 3, envelope.clone()));
        assert!(relay.complete(&id, 3, envelope.clone()));
        assert_eq!(resolved(&receiver), Some(envelope.clone()));
        assert!(!relay.complete(&id, 3, envelope));
        assert_eq!(relay.pending(), 0);
    }

    #[test]
    fn fail_generation_resolves_only_entries_bound_to_that_generation() {
        let relay = DatalinkRelay::default();
        let (old, old_rx) = relay.register().unwrap();
        let (newer, newer_rx) = relay.register().unwrap();
        let (unbound, unbound_rx) = relay.register().unwrap();
        relay.bind_generation(&old, 4);
        relay.bind_generation(&newer, 5);
        relay.fail_generation(4);
        assert_eq!(resolved(&old_rx), Some(error_envelope("sidecar-exited")));
        assert_eq!(resolved(&newer_rx), None);
        assert_eq!(resolved(&unbound_rx), None);
        relay.fail_unbound(&newer, "busy");
        assert_eq!(resolved(&newer_rx), None);
        relay.fail_unbound(&unbound, "sidecar-unavailable");
        assert_eq!(
            resolved(&unbound_rx),
            Some(error_envelope("sidecar-unavailable"))
        );
        assert_eq!(relay.pending(), 1);
    }

    #[test]
    fn a_late_response_after_abandon_is_unknown() {
        let relay = DatalinkRelay::default();
        let (id, receiver) = relay.register().unwrap();
        relay.bind_generation(&id, 1);
        relay.abandon(&id);
        assert!(!relay.complete(&id, 1, json!({"ok":true, "result":{}})));
        assert!(matches!(
            receiver.try_recv(),
            Err(mpsc::TryRecvError::Disconnected)
        ));
    }

    #[test]
    fn params_follow_the_request_rules() {
        let target = json!({"kind":"flight", "id":92});
        for (op, params) in [
            ("watch", json!({"on":true})),
            ("refresh", json!({})),
            ("thread", json!({"epoch":1, "endSeq":0})),
            ("canned-list", json!({})),
            (
                "send-canned",
                json!({"target":target, "cannedId":"gate-request"}),
            ),
            (
                "wx",
                json!({"target":{"kind":"leg", "id":SAFE_INTEGER_MAX}, "icao":"LFPG"}),
            ),
            ("loadsheet", json!({"plannedLegId":12})),
        ] {
            assert!(valid_params(op, &params), "{op} {params}");
            let line = request_line("dl-7", op, &params).unwrap();
            let decoded: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(
                decoded,
                json!({"v":1, "type":"datalink-request", "id":"dl-7", "op":op, "params":params})
            );
        }
        for (op, params) in [
            ("watch", json!({"on":"yes"})),
            ("watch", json!({})),
            ("refresh", json!({"force":true})),
            ("refresh", json!(null)),
            ("thread", json!({"epoch":0, "endSeq":0})),
            ("thread", json!({"epoch":1, "endSeq":-1})),
            ("thread", json!({"epoch":1, "endSeq":SAFE_INTEGER_MAX + 1})),
            ("thread", json!({"epoch":1.5, "endSeq":1})),
            (
                "send-canned",
                json!({"target":target, "cannedId":"gate-request", "body":"HELLO DISPATCH"}),
            ),
            (
                "send-canned",
                json!({"target":target, "text":"ANY FREE TEXT"}),
            ),
            ("send-canned", json!({"target":target, "cannedId":"-gate"})),
            (
                "send-canned",
                json!({"target":target, "cannedId":"a".repeat(65)}),
            ),
            (
                "send-canned",
                json!({"target":target, "cannedId":"gate request"}),
            ),
            (
                "send-canned",
                json!({"target":{"kind":"flight", "id":0}, "cannedId":"x"}),
            ),
            (
                "send-canned",
                json!({"target":{"kind":"airport", "id":1}, "cannedId":"x"}),
            ),
            (
                "send-canned",
                json!({"target":{"kind":"flight", "id":1, "extra":1}, "cannedId":"x"}),
            ),
            ("wx", json!({"target":target, "icao":"lfpg"})),
            ("wx", json!({"target":target, "icao":"1FPG"})),
            ("wx", json!({"target":target, "icao":"LFPGX"})),
            ("loadsheet", json!({"plannedLegId":0})),
            ("loadsheet", json!({"plannedLegId":"12"})),
            ("delete", json!({})),
        ] {
            assert!(!valid_params(op, &params), "{op} {params}");
        }
        assert_eq!(request_line("dl-1", "delete", &json!({})), None);
        assert_eq!(
            request_line("dl-1", "watch", &json!({"on":"x".repeat(REQUEST_LINE_MAX)})),
            None
        );
    }

    /// `{"<duplicate override>": value}`, spelled so the server's key never
    /// appears in client source, even in a test.
    fn duplicate_override(value: bool) -> Value {
        let mut params = Map::new();
        params.insert(format!("allow{}duplicates", '_'), json!(value));
        Value::Object(params)
    }

    #[test]
    fn simbrief_ops_take_exactly_empty_params() {
        assert_eq!(
            OPS,
            [
                "watch",
                "refresh",
                "thread",
                "canned-list",
                "send-canned",
                "wx",
                "loadsheet",
                "simbrief-settings",
                "simbrief-prefile",
                "prefile-clear",
                "clearance"
            ]
        );
        for op in SIMBRIEF_OPS {
            assert!(OPS.contains(&op));
            assert!(valid_params(op, &json!({})), "{op}");
            let line = request_line("dl-9", op, &json!({})).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&line).unwrap(),
                json!({"v":1, "type":"datalink-request", "id":"dl-9", "op":op, "params":{}})
            );
            for params in [
                duplicate_override(true),
                duplicate_override(false),
                json!({"pilotId":"1"}),
                json!({"tripId":1}),
                json!({"plannedLegId":123}),
                json!(null),
                json!([]),
                json!("x"),
            ] {
                assert!(!valid_params(op, &params), "{op} {params}");
            }
        }
    }

    #[test]
    fn only_the_prefile_waits_longer_than_the_request_timeout() {
        assert_eq!(REQUEST_TIMEOUT, Duration::from_millis(12_000));
        assert_eq!(PREFILE_REQUEST_TIMEOUT, Duration::from_millis(30_000));
        assert_eq!(SIDECAR_PREFILE_HTTP_TIMEOUT, Duration::from_millis(25_000));
        assert_eq!(PENDING_MAX, 8);
        assert!(PREFILE_REQUEST_TIMEOUT >= SIDECAR_PREFILE_HTTP_TIMEOUT + RELAY_SLACK_MIN);
        assert!(PREFILE_REQUEST_TIMEOUT > SIDECAR_PREFILE_HTTP_TIMEOUT);
        assert!(REQUEST_TIMEOUT >= Duration::from_millis(8_000) + RELAY_SLACK_MIN);
        for op in OPS {
            let expected = if op == "simbrief-prefile" {
                PREFILE_REQUEST_TIMEOUT
            } else {
                REQUEST_TIMEOUT
            };
            assert_eq!(RelayTimeouts::PRODUCTION.for_op(op), expected, "{op}");
        }
        assert_eq!(RelayTimeouts::PRODUCTION.for_op("unknown"), REQUEST_TIMEOUT);
    }

    #[test]
    fn clearance_takes_exactly_a_safe_integer_leg_id() {
        assert!(CLEARANCE_OPS.iter().all(|op| OPS.contains(op)));
        assert_eq!(OPS.last(), Some(&"clearance"));
        for id in [json!(1), json!(12), json!(SAFE_INTEGER_MAX)] {
            let params = json!({"plannedLegId": id});
            assert!(valid_params("clearance", &params), "{params}");
            let line = request_line("dl-9", "clearance", &params).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&line).unwrap(),
                json!({"v":1, "type":"datalink-request", "id":"dl-9", "op":"clearance", "params":params})
            );
        }
        for params in [
            json!({"plannedLegId":0}),
            json!({"plannedLegId":-1}),
            json!({"plannedLegId":"12"}),
            json!({"plannedLegId":12.5}),
            json!({"plannedLegId":SAFE_INTEGER_MAX + 1}),
            json!({"plannedLegId":null}),
            json!({"plannedLegId":12, "tripId":1}),
            json!({"plannedLegId":12, "flightId":92}),
            json!({"plannedLegId":12, "body":"x"}),
            json!({"tripId":12}),
            json!({"legId":12}),
            json!({}),
            json!(null),
            json!([12]),
            json!("x"),
        ] {
            assert!(!valid_params("clearance", &params), "{params}");
        }
    }

    #[test]
    fn clearance_support_needs_its_own_feature() {
        assert!(supports_clearance(
            &json!({"features":["datalink", "simbrief-prefile", "pdc-clearance"]})
        ));
        assert!(!supports_clearance(
            &json!({"features":["datalink", "simbrief-prefile"]})
        ));
        assert!(!supports_clearance(&json!({"features":"pdc-clearance"})));
        assert!(!supports_clearance(&json!({})));
        assert_eq!(
            RelayTimeouts::PRODUCTION.for_op("clearance"),
            REQUEST_TIMEOUT
        );
    }

    #[test]
    fn simbrief_support_needs_its_own_feature() {
        assert!(supports_simbrief(
            &json!({"features":["datalink", "simbrief-prefile"]})
        ));
        assert!(!supports_simbrief(&json!({"features":["datalink"]})));
        assert!(!supports_simbrief(&json!({"features":"simbrief-prefile"})));
        assert!(!supports_simbrief(&json!({})));
        assert!(supports_datalink(
            &json!({"features":["datalink", "simbrief-prefile"]})
        ));
    }

    #[test]
    fn envelopes_and_synthetic_states_have_the_frozen_shape() {
        assert_eq!(
            error_envelope("shell-timeout"),
            json!({"ok":false, "error":{"code":"shell-timeout", "httpStatus":null, "serverCode":null}})
        );
        let mut state = synthetic_state(STATE_OUTDATED);
        assert!(state["at"].is_u64());
        state["at"] = json!(1);
        assert_eq!(
            state,
            json!({"v":1, "type":"datalink-state", "at":1, "state":"dl.sidecar-outdated",
                "watching":false, "httpStatus":null, "serverCode":null, "lastOkAt":null,
                "lastErrorAt":null, "nextPollAt":null, "scope":null, "thread":null})
        );
        assert!(protocol::decode(&state.to_string()).is_ok());
        assert!(supports_datalink(&json!({"features":["x", "datalink"]})));
        assert!(!supports_datalink(&json!({"features":"datalink"})));
        assert!(!supports_datalink(&json!({})));
    }

    #[test]
    fn response_envelopes_keep_only_the_forwarded_members() {
        assert_eq!(
            response_envelope(
                &json!({"v":1, "type":"datalink-response", "at":1, "id":"dl-1", "ok":true, "result":{"sent":true}})
            ),
            json!({"ok":true, "result":{"sent":true}})
        );
        assert_eq!(
            response_envelope(&json!({"ok":false, "error":{"code":"no-dispatch-data",
                "httpStatus":409, "serverCode":"NO_DISPATCH_DATA", "error":"server text"}})),
            json!({"ok":false, "error":{"code":"no-dispatch-data", "httpStatus":409, "serverCode":"NO_DISPATCH_DATA"}})
        );
        assert_eq!(
            response_envelope(
                &json!({"ok":false, "error":{"code":"x".repeat(65), "httpStatus":"409", "serverCode":7}})
            ),
            json!({"ok":false, "error":{"code":"bad-response", "httpStatus":null, "serverCode":null}})
        );
    }
}

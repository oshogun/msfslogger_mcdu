use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Debug, PartialEq)]
pub enum DecodeError {
    NotJson,
    NotObject,
    BadVersion,
    UnknownType,
    BadShape,
}

pub fn decode(line: &str) -> Result<Value, DecodeError> {
    let value: Value = serde_json::from_str(line).map_err(|_| DecodeError::NotJson)?;
    let object = value.as_object().ok_or(DecodeError::NotObject)?;
    if object.get("v").and_then(Value::as_u64) != Some(1) {
        return Err(DecodeError::BadVersion);
    }
    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or(DecodeError::UnknownType)?;
    if ![
        "hello",
        "status",
        "log",
        "pong",
        "frame",
        "traffic",
        "datalink-response",
        "datalink-state",
    ]
    .contains(&kind)
    {
        return Err(DecodeError::UnknownType);
    }
    if !value["at"].is_number() {
        return Err(DecodeError::BadShape);
    }
    let valid = match kind {
        "hello" => {
            value["pid"].is_number()
                && ["sidecarVersion", "nodeVersion", "configPath"]
                    .iter()
                    .all(|key| value[key].is_string())
        }
        "status" => {
            ["app", "sim", "backend", "pause", "traffic"]
                .iter()
                .all(|key| value[key].is_object())
                && ["app", "sim", "backend", "pause"]
                    .iter()
                    .all(|key| value[key]["state"].is_string())
                && object.contains_key("config")
                && (value["config"].is_null() || value["config"].is_object())
        }
        "log" => {
            value["message"].is_string()
                && matches!(
                    value["level"].as_str(),
                    Some("debug" | "info" | "warn" | "error")
                )
        }
        "pong" => value["id"].is_string(),
        "frame" => value["frame"].is_object(),
        "traffic" => value["count"].is_number() && value["objects"].is_array(),
        "datalink-response" => {
            value["id"].is_string()
                && match value["ok"].as_bool() {
                    Some(true) => value["result"].is_object(),
                    Some(false) => value["error"].is_object() && value["error"]["code"].is_string(),
                    None => false,
                }
        }
        // Always a complete state, never a patch, so scope and thread are
        // present even when they are null.
        "datalink-state" => {
            value["state"].is_string()
                && value["watching"].is_boolean()
                && ["scope", "thread"].iter().all(|key| {
                    object.contains_key(*key) && (value[key].is_null() || value[key].is_object())
                })
        }
        _ => false,
    };
    if valid {
        Ok(value)
    } else {
        Err(DecodeError::BadShape)
    }
}

pub fn idle_status(state: &str) -> Value {
    json!({
        "v": 1, "type": "status", "at": now(), "app": {"state": state},
        "sim": {"state":"sim.idle", "attempt":0, "nextRetryAt":null, "retryDelayMs":null,
            "protocol":"KittyHawk", "appName":null, "appVersion":null, "lastError":null},
        "backend": {"state":"net.idle", "httpStatus":null, "lastOkAt":null, "lastErrorAt":null, "message":null},
        // The label carries the sidecar's own pause vocabulary (off, full,
        // active, with-sound, sim, unknown(n)), not a display string; no flags
        // set reads "off" there.
        "pause": {"state":"pause.off", "flags":0, "label":"off", "usingPauseEx1":false},
        "traffic": {"enabled":true, "radiusM":40000, "lastSweepAt":null, "lastBatchSize":null, "lastError":null},
        "config": null
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_messages_are_errors_not_panics() {
        for (line, error) in [
            ("{", DecodeError::NotJson),
            ("[]", DecodeError::NotObject),
            (r#"{"v":2}"#, DecodeError::BadVersion),
            (r#"{"v":1,"type":"new"}"#, DecodeError::UnknownType),
            (r#"{"v":1,"type":"status","at":1}"#, DecodeError::BadShape),
        ] {
            assert_eq!(decode(line), Err(error));
        }
        assert!(decode(&idle_status("app.stopped").to_string()).is_ok());
    }

    #[test]
    fn datalink_messages_are_accepted_only_in_their_frozen_shape() {
        for line in [
            r#"{"v":1,"type":"datalink-response","at":1,"id":"dl-1","ok":true,"result":{"watching":true,"leaseMs":65000}}"#,
            r#"{"v":1,"type":"datalink-response","at":1,"id":"dl-7","ok":false,"error":{"code":"no-dispatch-data","httpStatus":409,"serverCode":"NO_DISPATCH_DATA"}}"#,
            r#"{"v":1,"type":"datalink-state","at":1,"state":"dl.idle","watching":false,"httpStatus":null,"serverCode":null,"lastOkAt":null,"lastErrorAt":null,"nextPollAt":null,"scope":null,"thread":null}"#,
            r#"{"v":1,"type":"datalink-state","at":1,"state":"dl.ok","watching":true,"httpStatus":null,"serverCode":null,"lastOkAt":1,"lastErrorAt":null,"nextPollAt":2,"scope":{"kind":"flight","flightId":92,"plannedLegId":12},"thread":{"epoch":2,"total":5,"firstSeq":0,"newestId":18,"droppedRows":0}}"#,
            r#"{"v":1,"type":"hello","at":1,"pid":4242,"sidecarVersion":"1.1.0","nodeVersion":"v20.20.2","configPath":"C:\\scratch\\config.json","features":["datalink"]}"#,
        ] {
            assert!(decode(line).is_ok(), "{line}");
        }
        for line in [
            r#"{"v":1,"type":"datalink-response","id":"dl-1","ok":true,"result":{}}"#,
            r#"{"v":1,"type":"datalink-response","at":1,"id":7,"ok":true,"result":{}}"#,
            r#"{"v":1,"type":"datalink-response","at":1,"id":"dl-1","ok":"true","result":{}}"#,
            r#"{"v":1,"type":"datalink-response","at":1,"id":"dl-1","ok":true,"result":[]}"#,
            r#"{"v":1,"type":"datalink-response","at":1,"id":"dl-1","ok":false,"error":{"code":409}}"#,
            r#"{"v":1,"type":"datalink-response","at":1,"id":"dl-1","ok":false,"result":{}}"#,
            r#"{"v":1,"type":"datalink-state","at":1,"state":7,"watching":false,"scope":null,"thread":null}"#,
            r#"{"v":1,"type":"datalink-state","at":1,"state":"dl.idle","watching":"no","scope":null,"thread":null}"#,
            r#"{"v":1,"type":"datalink-state","at":1,"state":"dl.idle","watching":false,"scope":"flight","thread":null}"#,
            r#"{"v":1,"type":"datalink-state","at":1,"state":"dl.idle","watching":false,"scope":null,"thread":[]}"#,
            r#"{"v":1,"type":"datalink-state","at":1,"state":"dl.idle","watching":false,"scope":null}"#,
        ] {
            assert_eq!(decode(line), Err(DecodeError::BadShape), "{line}");
        }
        for line in [
            r#"{"v":1,"type":"datalink-request","id":"dl-1","op":"refresh","params":{}}"#,
            r#"{"v":1,"type":"datalink-patch","at":1}"#,
        ] {
            assert_eq!(decode(line), Err(DecodeError::UnknownType), "{line}");
        }
    }
}

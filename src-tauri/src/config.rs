use serde_json::{json, Map, Value};
use std::{env, fs::{self, OpenOptions}, io::Write, path::{Path, PathBuf}, sync::{Mutex, MutexGuard}, collections::BTreeSet};

pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A poisoned cache must not turn one failed operation into a blank panel.
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub struct ConfigStore {
    pub path: PathBuf,
    gate: Mutex<()>,
    secrets: Mutex<BTreeSet<String>>,
}

pub fn resolve_path() -> Result<PathBuf, String> {
    if let Ok(value) = env::var("MSFSLOGGER_CONFIG") {
        if !value.trim().is_empty() {
            let path = PathBuf::from(value.trim());
            return if path.is_absolute() { Ok(path) } else {
                env::current_dir().map(|cwd| cwd.join(path)).map_err(|_| "Cannot resolve config path".into())
            };
        }
    }
    #[cfg(windows)]
    let base = env::var_os("APPDATA").map(PathBuf::from).or_else(|| {
        env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join("AppData/Roaming"))
    });
    #[cfg(not(windows))]
    let base = env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()).map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")));
    base.map(|base| base.join("msfslogger/config.json"))
        .ok_or_else(|| "Cannot resolve the user's config directory".into())
}

impl ConfigStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path, gate: Mutex::new(()), secrets: Mutex::new(BTreeSet::new()) }
    }

    fn read_unlocked(&self) -> Result<Option<Map<String, Value>>, String> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("Config file is not readable".into()),
        };
        let text = std::str::from_utf8(&bytes).map_err(|_| "Config file must be UTF-8")?;
        let value: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
            .map_err(|_| "Config file is not valid JSON; repair it at the displayed config path")?;
        let object = value.as_object().ok_or("Config must be a JSON object")?.clone();
        self.remember(&object);
        Ok(Some(object))
    }

    pub fn read(&self) -> Result<Option<Map<String, Value>>, String> {
        let _guard = lock(&self.gate);
        self.read_unlocked()
    }

    fn remember(&self, object: &Map<String, Value>) {
        if let Some(token) = object.get("ingestToken").and_then(Value::as_str).filter(|token| !token.is_empty()) {
            let mut secrets = lock(&self.secrets);
            secrets.insert(token.to_owned());
            // stderr may contain a JSON-escaped representation of a credential.
            if let Ok(encoded) = serde_json::to_string(token) {
                secrets.insert(encoded[1..encoded.len() - 1].to_owned());
            }
        }
    }

    pub fn redact_text(&self, text: &str) -> String {
        let mut output = text.to_owned();
        for token in lock(&self.secrets).iter().rev() {
            output = output.replace(token, "[REDACTED]");
        }
        output
    }

    pub fn redact(&self, value: &mut Value) {
        match value {
            Value::Object(object) => {
                object.remove("ingestToken");
                for (key, child) in object.iter_mut() {
                    // Protocol identifiers and editable non-secret config
                    // fields must survive even if a short token happens to
                    // equal a public value such as "status" or "2020".
                    if matches!(key.as_str(), "type" | "state" | "level" | "protocol" | "sim"
                        | "serverUrl" | "certPath" | "nodePath" | "configPath"
                        | "sidecarVersion" | "nodeVersion") && child.is_string() { continue; }
                    self.redact(child);
                }
            }
            Value::Array(values) => for child in values { self.redact(child); },
            Value::String(text) => *text = self.redact_text(text),
            _ => {}
        }
    }

    pub fn snapshot(&self, effective: Value) -> Result<Value, String> {
        let raw = self.read()?;
        let exists = raw.is_some();
        let mut redacted = raw.map(|mut object| {
            let token_set = object.remove("ingestToken").and_then(|value| value.as_str().map(|s| !s.trim().is_empty())).unwrap_or(false);
            object.insert("tokenSet".into(), Value::Bool(token_set));
            Value::Object(object)
        }).unwrap_or(Value::Null);
        self.redact(&mut redacted);
        Ok(json!({ "exists": exists, "path": self.path, "config": effective, "raw": redacted }))
    }

    pub fn save(&self, patch: Value) -> Result<(), String> {
        let patch = patch.as_object().ok_or("Config patch must be a JSON object")?;
        let _guard = lock(&self.gate);
        // Refuse unreadable/non-object files; silently replacing one would lose
        // unknown settings. Semantic errors remain the sidecar's responsibility.
        let mut object = self.read_unlocked()?.unwrap_or_default();
        object.extend(patch.clone());
        self.remember(&object);
        let mut bytes = serde_json::to_vec_pretty(&object).map_err(|_| "Cannot encode config")?;
        bytes.push(b'\n');
        atomic_write(&self.path, &bytes)
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Config path has no parent directory")?;
    fs::create_dir_all(parent).map_err(|_| "Cannot create config directory")?;
    // Exclusive creation prevents two app instances from sharing a temporary
    // file. A stale file from a crash can be removed without touching config.
    let temp = path.with_extension("json.tmp");
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp).map_err(|_| "Cannot create config.json.tmp; close other instances or remove a stale temporary file")?;
    let written = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    let result = written.and_then(|_| fs::rename(&temp, path));
    if result.is_err() { let _ = fs::remove_file(&temp); }
    result.map_err(|_| "Cannot save config atomically; previous config retained".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_credentials_do_not_change_public_protocol_identifiers() {
        let store = ConfigStore::new(PathBuf::from("unused"));
        store.remember(json!({"ingestToken":"status"}).as_object().unwrap());
        let mut status = json!({"type":"status", "message":"credential status", "config":{"ingestToken":"status"}});
        store.redact(&mut status);
        assert_eq!(status["type"], "status");
        assert_eq!(status["message"], "credential [REDACTED]");
        assert!(status["config"].get("ingestToken").is_none());
    }

    #[test]
    fn saves_merge_unknown_keys_and_never_return_the_token() {
        let directory = env::temp_dir().join(format!("msfslogger-config-test-{}", std::process::id()));
        let store = ConfigStore::new(directory.join("config.json"));
        assert_eq!(store.snapshot(Value::Null).unwrap()["exists"], false);
        store.save(json!({"ingestToken":"PLACEHOLDER-TOKEN", "future": {"kept":true}, "autoUplink":false})).unwrap();
        store.save(json!({"sim":"2024"})).unwrap();
        let snapshot = store.snapshot(Value::Null).unwrap();
        assert_eq!(snapshot["raw"]["future"]["kept"], true);
        assert_eq!(snapshot["raw"]["tokenSet"], true);
        assert!(!snapshot.to_string().contains("PLACEHOLDER-TOKEN"));
        assert!(!directory.join("config.json.tmp").exists());
        fs::write(&store.path, "{broken").unwrap();
        assert!(store.save(json!({"sim":"fsx"})).is_err());
        assert_eq!(fs::read_to_string(&store.path).unwrap(), "{broken");
        fs::remove_dir_all(directory).unwrap();
    }
}

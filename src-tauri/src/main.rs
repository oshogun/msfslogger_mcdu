#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod datalink;
mod framing;
mod protocol;
mod restart;
mod supervisor;

use config::{lock, ConfigStore};
use serde_json::{json, Value};
use std::sync::Arc;
use supervisor::{Event, Operation, Supervisor};
use tauri::{Emitter, Manager, State};

#[tauri::command]
fn config_get(state: State<'_, Supervisor>) -> Value {
    let effective = lock(&state.snapshot)
        .status
        .as_ref()
        .map(|s| s["config"].clone())
        .unwrap_or(Value::Null);
    state.config.snapshot(effective).unwrap_or_else(|_| json!({
        "exists": state.config.path.exists(), "path": state.config.path, "config":null, "raw":null
    }))
}

#[tauri::command]
fn config_set(patch: Value, state: State<'_, Supervisor>) -> Value {
    match state.config.save(patch) {
        Ok(()) => {
            // Read newly saved raw fields until the sidecar validates them.
            if let Some(status) = lock(&state.snapshot).status.as_mut() {
                status["config"] = Value::Null;
            }
            match state.request(Operation::Reload) {
                Ok(()) => json!({"ok":true, "path":state.config.path}),
                Err(_) => {
                    json!({"ok":false, "message":"Config saved; supervisor unavailable for reload. Restart the app."})
                }
            }
        }
        Err(message) => json!({"ok":false, "message":message}),
    }
}

#[tauri::command]
fn config_path(state: State<'_, Supervisor>) -> String {
    lock(&state.snapshot)
        .hello
        .as_ref()
        .and_then(|h| h["configPath"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| state.config.path.to_string_lossy().into_owned())
}

#[tauri::command]
fn uplink_start(state: State<'_, Supervisor>) -> Result<(), String> {
    state.request(Operation::Start)
}

#[tauri::command]
fn uplink_stop(state: State<'_, Supervisor>) -> Result<(), String> {
    state.request(Operation::Stop)
}

#[tauri::command]
fn sidecar_restart(state: State<'_, Supervisor>) -> Result<(), String> {
    state.request(Operation::Restart)
}

#[tauri::command]
fn status_get(state: State<'_, Supervisor>) -> Option<Value> {
    lock(&state.snapshot).status.clone()
}

#[tauri::command]
fn datalink_state(state: State<'_, Supervisor>) -> Value {
    state.current_datalink_state()
}

// A relayed op can wait seconds for the sidecar, so it runs off the main
// thread. Err is reserved for the blocking task itself failing; every datalink
// outcome, including refusals, comes back as an Ok envelope.
async fn relay_datalink(
    state: State<'_, Supervisor>,
    op: &'static str,
    params: Value,
) -> Result<Value, String> {
    let supervisor = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || supervisor.datalink(op, params))
        .await
        .map_err(|_| "Datalink relay failed".into())
}

#[tauri::command]
async fn datalink_watch(on: bool, state: State<'_, Supervisor>) -> Result<Value, String> {
    relay_datalink(state, "watch", json!({"on": on})).await
}

#[tauri::command]
async fn datalink_refresh(state: State<'_, Supervisor>) -> Result<Value, String> {
    relay_datalink(state, "refresh", json!({})).await
}

#[tauri::command]
async fn datalink_thread(
    epoch: u64,
    end_seq: u64,
    state: State<'_, Supervisor>,
) -> Result<Value, String> {
    relay_datalink(state, "thread", json!({"epoch": epoch, "endSeq": end_seq})).await
}

#[tauri::command]
async fn datalink_canned(state: State<'_, Supervisor>) -> Result<Value, String> {
    relay_datalink(state, "canned-list", json!({})).await
}

#[tauri::command]
async fn datalink_send_canned(
    target_kind: String,
    target_id: u64,
    canned_id: String,
    state: State<'_, Supervisor>,
) -> Result<Value, String> {
    let params = json!({"target": {"kind": target_kind, "id": target_id}, "cannedId": canned_id});
    relay_datalink(state, "send-canned", params).await
}

#[tauri::command]
async fn datalink_wx(
    target_kind: String,
    target_id: u64,
    icao: String,
    state: State<'_, Supervisor>,
) -> Result<Value, String> {
    let params = json!({"target": {"kind": target_kind, "id": target_id}, "icao": icao});
    relay_datalink(state, "wx", params).await
}

#[tauri::command]
async fn datalink_loadsheet(
    planned_leg_id: u64,
    state: State<'_, Supervisor>,
) -> Result<Value, String> {
    relay_datalink(state, "loadsheet", json!({"plannedLegId": planned_leg_id})).await
}

// The SimBrief commands take no arguments: the server picks the pilot's
// current OFP, and nothing here can force a duplicate or write a Pilot ID.
#[tauri::command]
async fn simbrief_settings(state: State<'_, Supervisor>) -> Result<Value, String> {
    relay_datalink(state, "simbrief-settings", json!({})).await
}

#[tauri::command]
async fn simbrief_prefile(state: State<'_, Supervisor>) -> Result<Value, String> {
    relay_datalink(state, "simbrief-prefile", json!({})).await
}

#[tauri::command]
async fn simbrief_clear_prefile(state: State<'_, Supervisor>) -> Result<Value, String> {
    relay_datalink(state, "prefile-clear", json!({})).await
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            let resource = app
                .path()
                .resolve(
                    "sidecar/dist/index.js",
                    tauri::path::BaseDirectory::Resource,
                )
                .ok();
            let config_path = config::resolve_path().map_err(std::io::Error::other)?;
            let sink = Arc::new(move |event: Event| match event {
                Event::Status(value) => {
                    let _ = handle.emit("sidecar:status", value);
                }
                Event::Log(value) => {
                    let _ = handle.emit("sidecar:log", value);
                }
                Event::Exit(value) => {
                    let _ = handle.emit("sidecar:exit", value);
                }
                Event::Datalink(value) => {
                    let _ = handle.emit("sidecar:datalink", value);
                }
            });
            let supervisor = Supervisor::new(ConfigStore::new(config_path), resource, sink)
                .map_err(std::io::Error::other)?;
            app.manage(supervisor);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config_get,
            config_set,
            config_path,
            uplink_start,
            uplink_stop,
            sidecar_restart,
            status_get,
            datalink_state,
            datalink_watch,
            datalink_refresh,
            datalink_thread,
            datalink_canned,
            datalink_send_canned,
            datalink_wx,
            datalink_loadsheet,
            simbrief_settings,
            simbrief_prefile,
            simbrief_clear_prefile
        ])
        .build(tauri::generate_context!())
        .expect("Cannot initialize msfslogger desktop shell");
    app.run(|handle, event| match event {
        tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::CloseRequested { .. },
            ..
        }
        | tauri::RunEvent::ExitRequested { .. }
        | tauri::RunEvent::Exit => {
            if let Some(supervisor) = handle.try_state::<Supervisor>() {
                supervisor.shutdown();
            }
        }
        _ => {}
    });
}

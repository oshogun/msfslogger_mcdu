#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
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
    let effective = lock(&state.snapshot).status.as_ref().map(|s| s["config"].clone()).unwrap_or(Value::Null);
    state.config.snapshot(effective).unwrap_or_else(|_| json!({
        "exists": state.config.path.exists(), "path": state.config.path, "config":null, "raw":null
    }))
}

#[tauri::command]
fn config_set(patch: Value, state: State<'_, Supervisor>) -> Value {
    match state.config.save(patch) {
        Ok(()) => {
            // Read newly saved raw fields until the sidecar validates them.
            if let Some(status) = lock(&state.snapshot).status.as_mut() { status["config"] = Value::Null; }
            match state.request(Operation::Reload) {
                Ok(()) => json!({"ok":true, "path":state.config.path}),
                Err(_) => json!({"ok":false, "message":"Config saved; supervisor unavailable for reload. Restart the app."}),
            }
        },
        Err(message) => json!({"ok":false, "message":message}),
    }
}

#[tauri::command]
fn config_path(state: State<'_, Supervisor>) -> String {
    lock(&state.snapshot).hello.as_ref().and_then(|h| h["configPath"].as_str()).map(str::to_owned)
        .unwrap_or_else(|| state.config.path.to_string_lossy().into_owned())
}

#[tauri::command]
fn uplink_start(state: State<'_, Supervisor>) -> Result<(), String> { state.request(Operation::Start) }

#[tauri::command]
fn uplink_stop(state: State<'_, Supervisor>) -> Result<(), String> { state.request(Operation::Stop) }

#[tauri::command]
fn sidecar_restart(state: State<'_, Supervisor>) -> Result<(), String> { state.request(Operation::Restart) }

#[tauri::command]
fn status_get(state: State<'_, Supervisor>) -> Option<Value> { lock(&state.snapshot).status.clone() }

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            let resource = app.path().resolve("sidecar/dist/index.js", tauri::path::BaseDirectory::Resource).ok();
            let config_path = config::resolve_path().map_err(std::io::Error::other)?;
            let sink = Arc::new(move |event| match event {
                Event::Status(value) => { let _ = handle.emit("sidecar:status", value); }
                Event::Log(value) => { let _ = handle.emit("sidecar:log", value); }
                Event::Exit(value) => { let _ = handle.emit("sidecar:exit", value); }
            });
            let supervisor = Supervisor::new(ConfigStore::new(config_path), resource, sink).map_err(std::io::Error::other)?;
            app.manage(supervisor);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![config_get, config_set, config_path, uplink_start, uplink_stop, sidecar_restart, status_get])
        .build(tauri::generate_context!())
        .expect("Cannot initialize msfslogger desktop shell");
    app.run(|handle, event| {
        match event {
            tauri::RunEvent::WindowEvent { event: tauri::WindowEvent::CloseRequested { .. }, .. }
            | tauri::RunEvent::ExitRequested { .. }
            | tauri::RunEvent::Exit => {
                if let Some(supervisor) = handle.try_state::<Supervisor>() { supervisor.shutdown(); }
            }
            _ => {}
        }
    });
}

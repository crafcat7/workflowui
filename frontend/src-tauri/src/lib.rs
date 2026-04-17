use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

struct BackendProcess(Mutex<Option<Child>>);

impl Drop for BackendProcess {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.lock().unwrap().take() {
            let _ = child.kill();
            println!("[Tauri] Backend process terminated");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BackendProcess(Mutex::new(None)))
        .setup(|app| {
            // Spawn the C++ backend process
            let backend_path = if cfg!(debug_assertions) {
                std::env::var("WORKFLOW_BACKEND_PATH")
                    .unwrap_or_else(|_| "../../backend/build/workflow_backend".to_string())
            } else {
                let resource_dir = app
                    .path()
                    .resource_dir()
                    .expect("failed to get resource dir");
                resource_dir
                    .join("workflow_backend")
                    .to_string_lossy()
                    .to_string()
            };

            match Command::new(&backend_path).arg("9090").spawn() {
                Ok(child) => {
                    println!("[Tauri] Backend started (pid: {})", child.id());
                    let state: tauri::State<BackendProcess> = app.state();
                    *state.0.lock().unwrap() = Some(child);
                }
                Err(e) => {
                    eprintln!(
                        "[Tauri] Failed to start backend: {} (path: {})",
                        e, backend_path
                    );
                    eprintln!("[Tauri] Running in frontend-only mode");
                }
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

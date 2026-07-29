use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

/// Handle to the Python sidecar (src/lumitrack/sidecar.py) launched at
/// startup, so it can be killed when the window closes instead of lingering
/// as an orphan process.
///
/// Dev-only launch strategy: run the repo's `src/` on PYTHONPATH with the
/// system `python`. Packaging this as a proper `externalBin` sidecar
/// (CONCEPTION.md §12.11) is explicitly left open in §12.13 and not done
/// here.
struct SidecarProcess(Mutex<Option<Child>>);

fn spawn_sidecar() -> std::io::Result<Child> {
  // `cargo tauri dev` runs with cwd = frontend/src-tauri, so the repo's
  // Python package lives two levels up.
  let repo_src = std::env::current_dir()?.join("..").join("..").join("src");

  Command::new("python")
    .args(["-m", "lumitrack"])
    .env("PYTHONPATH", &repo_src)
    .stdout(Stdio::inherit())
    .stderr(Stdio::inherit())
    .spawn()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      match spawn_sidecar() {
        Ok(child) => {
          log::info!("Lumitrack sidecar started (pid {})", child.id());
          app.manage(SidecarProcess(Mutex::new(Some(child))));
        }
        Err(err) => {
          log::error!(
            "Failed to start the Python sidecar ({err}). Start it manually: \
             PYTHONPATH=src python -m lumitrack"
          );
        }
      }

      Ok(())
    })
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::CloseRequested { .. } = event {
        if let Some(state) = window.app_handle().try_state::<SidecarProcess>() {
          if let Some(mut child) = state.0.lock().unwrap().take() {
            let _ = child.kill();
          }
        }
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

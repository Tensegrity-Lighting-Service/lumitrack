use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

/// Handle to the Python sidecar (src/lumitrack/sidecar.py) launched at
/// startup, so it can be killed when the window closes instead of lingering
/// as an orphan process.
///
/// Debug: run the repo's `src/` on PYTHONPATH with the system `python`
/// (console output inherited, visible in the dev terminal). Release: the
/// PyInstaller exe bundled as a Tauri `externalBin` (CONCEPTION.md §12.11,
/// packaging/build-sidecar.bat), installed next to the app exe — spawned
/// with CREATE_NO_WINDOW so no console window ever flashes for end users.
struct SidecarProcess(Mutex<Option<Child>>);

fn spawn_sidecar() -> std::io::Result<Child> {
  let mut cmd = if cfg!(debug_assertions) {
    // `cargo tauri dev` runs with cwd = frontend/src-tauri, so the repo's
    // Python package lives two levels up.
    let repo_src = std::env::current_dir()?.join("..").join("..").join("src");
    let mut c = Command::new("python");
    c.args(["-m", "lumitrack"])
      .env("PYTHONPATH", &repo_src)
      .stdout(Stdio::inherit())
      .stderr(Stdio::inherit());
    c
  } else {
    // Un sidecar ORPHELIN (app tuée sans passer par CloseRequested, cf.
    // CONCEPTION.md 14.6 — même problème que le .bat de dev règle en
    // libérant le port 17845) garderait le port et ferait échouer le
    // nôtre en silence. L'instance unique garantit qu'aucune AUTRE app
    // Lumitrack ne tourne : tout lumitrack-sidecar.exe vivant ici est un
    // orphelin, à terminer avant de lancer le nôtre.
    #[cfg(windows)]
    {
      use std::os::windows::process::CommandExt;
      let _ = Command::new("taskkill")
        .args(["/F", "/IM", "lumitrack-sidecar.exe"])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .status();
    }

    // Tauri strips the platform-triple suffix when bundling: the installed
    // file sits next to the app exe as plain `lumitrack-sidecar.exe`.
    let exe_dir = std::env::current_exe()?
      .parent()
      .ok_or_else(|| std::io::Error::other("app exe has no parent dir"))?
      .to_path_buf();
    let mut c = Command::new(exe_dir.join("lumitrack-sidecar.exe"));
    // The app itself is a GUI process: a console child would pop its own
    // console window without CREATE_NO_WINDOW. Output goes nowhere in
    // release — null keeps the exe's sys.stdout valid (the sidecar was
    // deliberately built WITHOUT --noconsole, see build-sidecar.bat).
    c.stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
      use std::os::windows::process::CommandExt;
      const CREATE_NO_WINDOW: u32 = 0x0800_0000;
      c.creation_flags(CREATE_NO_WINDOW);
    }
    c
  };
  cmd.spawn()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let mut builder = tauri::Builder::default();

  // Instance unique — DOIT etre le premier plugin enregistre (doc du
  // plugin) : un second lancement ne cree rien, il ramene la fenetre de
  // l'instance existante au premier plan.
  #[cfg(not(any(target_os = "android", target_os = "ios")))]
  {
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
      if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
      }
    }));
  }

  builder
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
        // Uniquement la fenêtre PRINCIPALE (fix 2026-08-06) : le splash se
        // ferme programmatiquement quelques secondes après le démarrage
        // (App.tsx::revealMainWindow) — sans ce filtre, SA fermeture
        // consommait le handle et tuait le sidecar de l'app vivante.
        if window.label() != "main" {
          return;
        }
        if let Some(state) = window.app_handle().try_state::<SidecarProcess>() {
          if let Some(mut child) = state.0.lock().unwrap().take() {
            // PyInstaller --onefile = DEUX processus (bootloader + python
            // extrait) : kill() ne tue que le bootloader et ORPHELINISE
            // l'enfant, qui garde le port 17845 (constaté à l'installation
            // du 2026-08-06, "Error opening file for writing"). taskkill
            // /T termine l'arbre entier ; kill()/wait() en filet (dev =
            // python direct, un seul processus).
            #[cfg(windows)]
            {
              use std::os::windows::process::CommandExt;
              let _ = Command::new("taskkill")
                .args(["/F", "/T", "/PID", &child.id().to_string()])
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .status();
            }
            let _ = child.kill();
            let _ = child.wait();
          }
        }
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

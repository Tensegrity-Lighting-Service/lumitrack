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

/// Fichier .lumitrack passé en argument au lancement (double-clic sur un
/// projet dans l'Explorateur, via l'association de fichier du bundle) —
/// interrogé par le frontend une fois connecté au sidecar, qui seul sait
/// charger un projet (§13.1.7).
#[tauri::command]
fn startup_file() -> Option<String> {
  std::env::args()
    .nth(1)
    .filter(|a| a.to_lowercase().ends_with(".lumitrack"))
}

/// Canal de mise à jour (tranche F, 2026-08-07) : le canal est choisi à
/// RUNTIME par le frontend (réglage machine, localStorage), donc les
/// endpoints statiques de tauri.conf.json ne suffisent plus — ces deux
/// commandes construisent l'updater avec l'endpoint du canal demandé.
/// - stable : latest.json de la DERNIÈRE release GitHub (les prereleases
///   en sont exclues par GitHub, le canal stable ne voit jamais la bêta) ;
/// - beta : latest.json de la release ROULANTE taguée `beta` (prerelease),
///   écrasée à chaque build bêta. Même clé de signature pour les deux.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod updater_channel {
  const STABLE_URL: &str =
    "https://github.com/Tensegrity-Lighting-Service/lumitrack/releases/latest/download/latest.json";
  const BETA_URL: &str =
    "https://github.com/Tensegrity-Lighting-Service/lumitrack/releases/download/beta/latest.json";

  fn endpoint(channel: &str) -> &'static str {
    if channel == "beta" { BETA_URL } else { STABLE_URL }
  }

  async fn updater_for(
    app: &tauri::AppHandle,
    channel: &str,
  ) -> Result<tauri_plugin_updater::Updater, String> {
    use tauri_plugin_updater::UpdaterExt;
    app
      .updater_builder()
      .endpoints(vec![endpoint(channel).parse().map_err(|e| format!("{e}"))?])
      .map_err(|e| e.to_string())?
      .build()
      .map_err(|e| e.to_string())
  }

  #[derive(serde::Serialize)]
  pub struct UpdateInfo {
    pub version: String,
    pub body: Option<String>,
  }

  #[tauri::command]
  pub async fn check_update_channel(
    app: tauri::AppHandle,
    channel: String,
  ) -> Result<Option<UpdateInfo>, String> {
    let updater = updater_for(&app, &channel).await?;
    match updater.check().await {
      Ok(Some(u)) => Ok(Some(UpdateInfo { version: u.version.clone(), body: u.body.clone() })),
      Ok(None) => Ok(None),
      Err(e) => Err(e.to_string()),
    }
  }

  /// Télécharge et installe la mise à jour du canal. Progression remontée
  /// au frontend par l'événement `update-progress` (0-100). Sous Windows,
  /// l'installateur NSIS ferme l'app lui-même en fin d'installation.
  #[tauri::command]
  pub async fn install_update_channel(app: tauri::AppHandle, channel: String) -> Result<(), String> {
    use tauri::Emitter;
    let updater = updater_for(&app, &channel).await?;
    let update = updater
      .check()
      .await
      .map_err(|e| e.to_string())?
      .ok_or_else(|| "no update available".to_string())?;
    let emit_app = app.clone();
    let mut received: u64 = 0;
    update
      .download_and_install(
        move |chunk, total| {
          received += chunk as u64;
          if let Some(total) = total {
            if total > 0 {
              let pct = ((received as f64 / total as f64) * 100.0).min(100.0) as u32;
              let _ = emit_app.emit("update-progress", pct);
            }
          }
        },
        || {},
      )
      .await
      .map_err(|e| e.to_string())?;
    Ok(())
  }
}

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
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
      if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        // Double-clic sur un .lumitrack alors que l'app tourne déjà : le
        // second lancement nous relaie son argv — transmettre le fichier
        // au frontend, qui demandera le chargement au sidecar.
        if let Some(path) = argv.into_iter().skip(1)
          .find(|a| a.to_lowercase().ends_with(".lumitrack"))
        {
          use tauri::Emitter;
          let _ = win.emit("open-file", path);
        }
      }
    }));
  }

  // Mises à jour signées via GitHub Releases (latest.json) — le frontend
  // vérifie au démarrage et propose installer/plus tard/voir la page.
  #[cfg(not(any(target_os = "android", target_os = "ios")))]
  {
    builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
  }

  #[cfg(not(any(target_os = "android", target_os = "ios")))]
  let builder = builder.invoke_handler(tauri::generate_handler![
    startup_file,
    updater_channel::check_update_channel,
    updater_channel::install_update_channel
  ]);
  #[cfg(any(target_os = "android", target_os = "ios"))]
  let builder = builder.invoke_handler(tauri::generate_handler![startup_file]);

  builder
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_opener::init())
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

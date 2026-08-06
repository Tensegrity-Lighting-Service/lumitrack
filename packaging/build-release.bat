@echo off
setlocal
rem Build complet de la release installable, en UNE commande VISIBLE
rem (demande 2026-08-06 : "une progress bar visible pour ce cas-ci") :
rem a lancer dans un terminal, chaque outil (PyInstaller, tsc/vite, cargo,
rem NSIS) affiche sa propre progression en direct. Etapes numerotees pour
rem savoir ou on en est ; s'arrete NET a la premiere erreur.
cd /d "%~dp0.."

echo ==============================================================
echo  [1/2] Sidecar Python (PyInstaller) -- ~20 s
echo ==============================================================
call packaging\build-sidecar.bat
if errorlevel 1 (
  echo ECHEC etape 1/2 : sidecar PyInstaller.
  exit /b 1
)

rem Signature des mises a jour (updater GitHub Releases, 2026-08-06) : la
rem cle privee vit HORS du depot. Si tu la perds, les apps installees ne
rem pourront plus jamais se mettre a jour automatiquement -- sauvegarde-la.
if not exist "%USERPROFILE%\.tauri\lumitrack-updater.key" (
  echo ECHEC : cle de signature introuvable ^(%USERPROFILE%\.tauri\lumitrack-updater.key^).
  exit /b 1
)
rem Tauri v2 lit TAURI_SIGNING_PRIVATE_KEY (chemin OU contenu) — la
rem variante _PATH n'est pas reconnue par le build.
set "TAURI_SIGNING_PRIVATE_KEY=%USERPROFILE%\.tauri\lumitrack-updater.key"
set "TAURI_SIGNING_PRIVATE_KEY_PASSWORD="

echo.
echo ==============================================================
echo  [2/3] Installateur Tauri (frontend + Rust release + NSIS)
echo         ~2-5 min -- cargo affiche sa progression ci-dessous
echo ==============================================================
cd frontend
call npm run tauri build
if errorlevel 1 (
  echo ECHEC etape 2/3 : tauri build.
  exit /b 1
)

echo.
echo ==============================================================
echo  [3/3] Manifeste updater ^(latest.json^)
echo ==============================================================
cd ..
python packaging\make_latest_json.py
if errorlevel 1 (
  echo ECHEC etape 3/3 : latest.json.
  exit /b 1
)
cd frontend

echo.
echo ==============================================================
echo  TERMINE. Installateur :
echo  frontend\src-tauri\target\release\bundle\nsis\
dir /b "src-tauri\target\release\bundle\nsis\*.exe"
echo ==============================================================

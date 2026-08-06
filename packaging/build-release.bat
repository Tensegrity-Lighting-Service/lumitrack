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

echo.
echo ==============================================================
echo  [2/2] Installateur Tauri (frontend + Rust release + NSIS)
echo         ~2-5 min -- cargo affiche sa progression ci-dessous
echo ==============================================================
cd frontend
call npm run tauri build
if errorlevel 1 (
  echo ECHEC etape 2/2 : tauri build.
  exit /b 1
)

echo.
echo ==============================================================
echo  TERMINE. Installateur :
echo  frontend\src-tauri\target\release\bundle\nsis\
dir /b "src-tauri\target\release\bundle\nsis\*.exe"
echo ==============================================================

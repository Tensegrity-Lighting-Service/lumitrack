@echo off
setlocal
rem Empaquete le sidecar Python en .exe autonome pour la release installable
rem (2026-08-06). A lancer AVANT `npm run tauri build` - tauri.conf.json
rem declare le binaire en externalBin et le build echoue s'il manque.
rem
rem Mode console (PAS --noconsole) : sous --noconsole PyInstaller met
rem sys.stdout/stderr a None et le logging peut planter. La fenetre console
rem est masquee au lancement par l'app (CREATE_NO_WINDOW dans lib.rs).
cd /d "%~dp0.."

python -m PyInstaller --onefile --console --name lumitrack-sidecar ^
  --paths src ^
  --distpath frontend\src-tauri\binaries ^
  --workpath build\pyinstaller ^
  --specpath build\pyinstaller ^
  -y packaging\sidecar_entry.py
if errorlevel 1 exit /b 1

rem Convention externalBin de Tauri : le nom porte le triple de plateforme,
rem retire automatiquement a l'installation.
copy /y "frontend\src-tauri\binaries\lumitrack-sidecar.exe" ^
  "frontend\src-tauri\binaries\lumitrack-sidecar-x86_64-pc-windows-msvc.exe" >nul
del "frontend\src-tauri\binaries\lumitrack-sidecar.exe"

echo.
echo OK : frontend\src-tauri\binaries\lumitrack-sidecar-x86_64-pc-windows-msvc.exe

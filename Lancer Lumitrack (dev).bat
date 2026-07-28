@echo off
setlocal
title Lumitrack (dev)

rem Picks up Node/Rust even if they were installed after this shell's PATH
rem was cached (relevant right after a fresh toolchain install).
for /f "usebackq tokens=2,*" %%A in (`reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path`) do set "SYS_PATH=%%B"
for /f "usebackq tokens=2,*" %%A in (`reg query "HKCU\Environment" /v Path 2^>nul`) do set "USER_PATH=%%B"
set "PATH=%SYS_PATH%;%USER_PATH%;%PATH%"

rem Un sidecar orphelin peut rester accroche au port 17845 si l'app a ete
rem fermee brutalement (CONCEPTION.md 14.6) : le nouveau lancement echoue
rem alors en silence. On libere le port avant de demarrer.
echo Verification du port 17845 (sidecar orphelin)...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 17845 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Write-Host ('  - arret du processus orphelin PID ' + $_) ; Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"

cd /d "%~dp0frontend"

if not exist node_modules (
    echo Premiere installation, ca peut prendre une minute...
    call npm install
    if errorlevel 1 goto :error
)

echo Lancement de Lumitrack (sidecar Python + fenetre Tauri)...
call npm run tauri dev
if errorlevel 1 goto :error

goto :eof

:error
echo.
echo Une erreur est survenue. Cette fenetre reste ouverte pour que tu puisses la lire.
pause

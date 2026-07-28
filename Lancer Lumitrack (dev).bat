@echo off
setlocal
title Lumitrack (dev)

rem Picks up Node/Rust even if they were installed after this shell's PATH
rem was cached (relevant right after a fresh toolchain install).
for /f "usebackq tokens=2,*" %%A in (`reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path`) do set "SYS_PATH=%%B"
for /f "usebackq tokens=2,*" %%A in (`reg query "HKCU\Environment" /v Path 2^>nul`) do set "USER_PATH=%%B"
set "PATH=%SYS_PATH%;%USER_PATH%;%PATH%"

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

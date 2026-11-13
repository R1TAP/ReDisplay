@echo off
setlocal
set "REDISPLAY_DRIVER_SCRIPT=%~f0"
if /i "%~1"=="--quiet" set "QUIET=1"
powershell.exe -NoProfile -NonInteractive -Command "if (!([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 1 }"
if errorlevel 1 (
    powershell.exe -NoProfile -NonInteractive -Command "$p=Start-Process -FilePath $env:REDISPLAY_DRIVER_SCRIPT -Verb RunAs -PassThru -Wait -ErrorAction Stop; exit $p.ExitCode"
    exit /b
)

powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0install_driver.ps1"
if errorlevel 1 goto fail
echo [OK] Driver installation finished. Check Windows Display Settings for the virtual monitor.
if not defined QUIET pause
exit /b 0

:fail
echo [ERROR] Driver installation failed. See the command output above.
if not defined QUIET pause
exit /b 1

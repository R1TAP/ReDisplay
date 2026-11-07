@echo off
setlocal
set "REDISPLAY_DRIVER_SCRIPT=%~f0"
if /i "%~1"=="--quiet" set "QUIET=1"
powershell.exe -NoProfile -NonInteractive -Command "if (!([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 1 }"
if errorlevel 1 (
    powershell.exe -NoProfile -NonInteractive -Command "$p=Start-Process -FilePath $env:REDISPLAY_DRIVER_SCRIPT -Verb RunAs -PassThru -Wait -ErrorAction Stop; exit $p.ExitCode"
    exit /b
)

"%~dp0nefcon.exe" --remove-device-node --hardware-id "Root\MttVDD" --class-guid "{4d36e968-e325-11ce-bfc1-08002be10318}"
if errorlevel 1 goto fail
echo [OK] The MttVDD device was removed. The display settings XML is retained.
if not defined QUIET pause
exit /b 0

:fail
echo [ERROR] Driver removal failed. See the command output above.
if not defined QUIET pause
exit /b 1

@echo off
setlocal
set "REDISPLAY_DRIVER_SCRIPT=%~f0"
if /i "%~1"=="--quiet" set "QUIET=1"
powershell.exe -NoProfile -NonInteractive -Command "if (!([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 1 }"
if errorlevel 1 (
    powershell.exe -NoProfile -NonInteractive -Command "$p=Start-Process -FilePath $env:REDISPLAY_DRIVER_SCRIPT -Verb RunAs -PassThru -Wait -ErrorAction Stop; exit $p.ExitCode"
    exit /b
)

set "TARGET_DIR=%SystemDrive%\VirtualDisplayDriver"
if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%" || goto fail
if not exist "%TARGET_DIR%\vdd_settings.xml" (
    copy "%~dp0vdd_settings.xml" "%TARGET_DIR%\vdd_settings.xml" >nul || goto fail
)
"%~dp0nefcon.exe" devcon install "%~dp0files\MttVDD.inf" "Root\MttVDD" --no-duplicates
if errorlevel 1 goto fail
echo [OK] Driver installation finished. Check Windows Display Settings for the virtual monitor.
if not defined QUIET pause
exit /b 0

:fail
echo [ERROR] Driver installation failed. See the command output above.
if not defined QUIET pause
exit /b 1

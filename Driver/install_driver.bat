@echo off
chcp 65001 >nul
echo ============================================================
echo   ReDisplay Virtual Display Driver Installer
echo ============================================================

:: Check for administrative permissions
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [INFO] Requesting Administrator privileges...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

set DRIVER_DIR=%~dp0files
set TARGET_DIR=C:\VirtualDisplayDriver
set NEFCON=%~dp0nefcon.exe

echo [1/4] Setting up configuration folder: %TARGET_DIR%...
if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"
copy /y "%~dp0vdd_settings.xml" "%TARGET_DIR%\vdd_settings.xml" >nul

echo [2/4] Adding driver package to Windows Driver Store...
pnputil /add-driver "%DRIVER_DIR%\MttVDD.inf" /install

echo [3/4] Creating Virtual Display Device Node (Root\MttVDD)...
"%NEFCON%" --create-device-node --hardware-id "Root\MttVDD" --class-name "Display" --class-guid "{4d36e968-e325-11ce-bfc1-08002be10318}" --no-duplicates

echo [4/4] Activating Virtual Display Driver...
"%NEFCON%" --install-driver --inf-path "%DRIVER_DIR%\MttVDD.inf"

echo ============================================================
echo Success! Virtual display adapter is installed and activated!
echo Samsung Tab S9+ native resolution (2800x1752 @ 120Hz) is ready!
echo You can now check Windows Display Settings.
echo ============================================================
pause

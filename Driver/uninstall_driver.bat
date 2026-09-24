@echo off
chcp 65001 >nul
echo ============================================================
echo   ReDisplay Virtual Display Driver Uninstaller
echo ============================================================

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [INFO] Requesting Administrator privileges...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

set NEFCON=%~dp0nefcon.exe
set DRIVER_DIR=%~dp0files

echo [1/3] Removing Virtual Display Device Node...
if exist "%NEFCON%" (
    "%NEFCON%" --remove-device-node --hardware-id "Root\MttVDD" --class-guid "{4d36e968-e325-11ce-bfc1-08002be10318}"
)

echo [2/3] Removing driver package from driver store...
pnputil /delete-driver mttvdd.inf /uninstall /force >nul 2>&1

echo [3/3] Virtual Display Driver uninstalled successfully.
echo ============================================================
pause

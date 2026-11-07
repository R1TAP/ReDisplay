@echo off
setlocal
set "HOST_DIR=%~dp0"
if "%~1"=="" (
    set "OUT_DIR=%HOST_DIR%..\scratch\demo\bin"
) else (
    set "OUT_DIR=%~f1"
)

if not defined VCToolsInstallDir (
    for /f "usebackq delims=" %%V in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -prerelease -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VS_DIR=%%V"
)
if not defined VCToolsInstallDir if defined VS_DIR call "%VS_DIR%\VC\Auxiliary\Build\vcvarsall.bat" x64
if not defined VCToolsInstallDir (
    echo [ERROR] Visual Studio C++ x64 build tools and Windows SDK are required.
    exit /b 1
)
if not exist "%OUT_DIR%" mkdir "%OUT_DIR%" || exit /b 1
pushd "%OUT_DIR%" || exit /b 1
cl.exe /nologo /EHsc /std:c++20 /O2 /MD /W4 /DNOMINMAX ^
    /I "%HOST_DIR%include" /I "%HOST_DIR%src" ^
    "%HOST_DIR%src\main.cpp" "%HOST_DIR%src\adb.cpp" "%HOST_DIR%src\display_manager.cpp" ^
    "%HOST_DIR%src\encoder.cpp" "%HOST_DIR%src\capture.cpp" ^
    /link /OUT:ReDisplayHost.exe windowsapp.lib d3d11.lib dxgi.lib ws2_32.lib user32.lib
set "BUILD_RESULT=%ERRORLEVEL%"
if "%BUILD_RESULT%"=="0" if not exist config.ini (
    copy "%HOST_DIR%config.default.ini" config.ini >nul || set "BUILD_RESULT=1"
)
popd
exit /b %BUILD_RESULT%

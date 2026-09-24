@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ============================================================
echo   Building ReDisplay Windows Host (ReDisplayHost.exe)
echo ============================================================

set VCVARS="C:\Program Files\Microsoft Visual Studio\18\Insiders\VC\Auxiliary\Build\vcvarsall.bat"
if not exist %VCVARS% (
    echo [ERROR] Visual Studio vcvarsall.bat not found at %VCVARS%!
    exit /b 1
)

call %VCVARS% x64 >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Failed to initialize MSVC environment!
    exit /b 1
)

set HOST_DIR=%~dp0
set SRC_DIR=%HOST_DIR%src
set INC_DIR=%HOST_DIR%include

echo Compiling C++20 sources with MSVC optimizations (/O2)...
cl.exe /nologo /EHsc /std:c++20 /O2 /MD ^
    /D_SILENCE_EXPERIMENTAL_COROUTINE_DEPRECATION_WARNINGS ^
    /I "%INC_DIR%" /I "%SRC_DIR%" ^
    "%SRC_DIR%\main.cpp" ^
    "%SRC_DIR%\adb.cpp" ^
    "%SRC_DIR%\display_manager.cpp" ^
    "%SRC_DIR%\encoder.cpp" ^
    "%SRC_DIR%\capture.cpp" ^
    /link /OUT:"%HOST_DIR%ReDisplayHost.exe" ^
    windowsapp.lib d3d11.lib dxgi.lib ws2_32.lib user32.lib

if %errorlevel% equ 0 (
    copy /y "%HOST_DIR%ReDisplayHost.exe" "%HOST_DIR%ReDisplay.exe" >nul 2>&1
    echo ============================================================
    echo   SUCCESS: ReDisplayHost.exe built successfully!
    echo   Output: %HOST_DIR%ReDisplayHost.exe
    echo ============================================================
    del "%HOST_DIR%*.obj" >nul 2>&1
) else (
    echo [ERROR] Compilation failed!
    exit /b 1
)

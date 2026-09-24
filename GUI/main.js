const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');
const { spawn, execFile, exec, execSync } = require('child_process');
const readline = require('readline');
const fs = require('fs');

let mainWindow = null;
let tray = null;
let hostProcess = null;
let isQuitting = false;
let currentConfig = {
    profile: 'esports',
    fps: 120,
    bitrate: 60,
    width: 1752,
    height: 2800,
    bufferMode: 'lowlatency',
    orientation: 'portrait'
};
let latestStats = { fps: 0, mbps: 0, encodeMs: 0, dropped: 0, frames: 0 };
let streamStatus = 'idle'; // 'idle', 'connecting', 'streaming'
let activeStreamDeviceName = '';
let activeStreamSerial = '';
let hasShownTrayTip = false;
let lastTrayUpdateTime = 0;

// Dynamic Path Resolution
function getHostExePath() {
    const candidates = [
        path.join(__dirname, '..', 'bin', 'ReDisplayHost.exe'),
        path.join(__dirname, 'resources', 'bin', 'ReDisplayHost.exe'),
        path.join(__dirname, '..', 'Host', 'ReDisplayHost.exe'),
        path.join(__dirname, '..', 'Host', 'ReDisplay.exe'),
        path.join(__dirname, '..', '..', 'Host', 'ReDisplayHost.exe'),
        path.join(__dirname, '..', '..', 'Host', 'ReDisplay.exe'),
        path.join(__dirname, 'bin', 'ReDisplayHost.exe'),
        path.join(__dirname, 'ReDisplayHost.exe')
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return path.join(__dirname, '..', 'Host', 'ReDisplayHost.exe');
}

function getAdbPath() {
    const candidates = [
        path.join(__dirname, '..', 'bin', 'adb.exe'),
        path.join(__dirname, 'resources', 'bin', 'adb.exe'),
        path.join(__dirname, '..', 'resources', 'bin', 'adb.exe'),
        path.join(__dirname, '..', 'ReDisplay-Win64', 'resources', 'bin', 'adb.exe'),
        'C:\\Program Files\\QtScrcpy-win-x64-v3.2.0\\adb.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe')
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return 'adb.exe';
}

function getApkPath() {
    const candidates = [
        path.join(__dirname, '..', 'Client', 'ReDisplay.apk'),
        path.join(__dirname, 'resources', 'Client', 'ReDisplay.apk'),
        path.join(__dirname, '..', '..', 'Client', 'ReDisplay.apk'),
        path.join(__dirname, 'Client', 'ReDisplay.apk')
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return '';
}

function getDriverScriptPath(action) {
    const scriptName = (action === 'uninstall') ? 'uninstall_driver.bat' : 'install_driver.bat';
    const candidates = [
        path.join(__dirname, '..', 'Driver', scriptName),
        path.join(__dirname, 'resources', 'Driver', scriptName),
        path.join(__dirname, '..', '..', 'Driver', scriptName),
        path.join(__dirname, 'Driver', scriptName)
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return '';
}

function createWindow() {
    const appIcon = fs.existsSync(path.join(__dirname, 'assets', 'icon.ico'))
        ? path.join(__dirname, 'assets', 'icon.ico')
        : path.join(__dirname, 'assets', 'icon.png');

    mainWindow = new BrowserWindow({
        title: 'ReDisplay - 超低延迟有线副屏系统',
        width: 1040,
        height: 800,
        minWidth: 900,
        minHeight: 680,
        frame: false,
        backgroundColor: '#141218',
        icon: appIcon,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
        console.log(`[Renderer] ${message}`);
    });

    // Fix: Safely handle minimize to tray on close without calling non-existent Tray.isSupported()
    mainWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            mainWindow.hide();
            if (!hasShownTrayTip && tray) {
                hasShownTrayTip = true;
                try {
                    tray.displayBalloon({
                        title: 'ReDisplay 已最小化至系统托盘',
                        content: '副屏服务保持在后台无感运行。双击托盘图标可随时恢复主界面。'
                    });
                } catch (e) {}
            }
        }
    });
}

function sendTrayConfigChange(patch) {
    currentConfig = { ...currentConfig, ...patch };
    updateTrayMenu();
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tray-action', { action: 'change-config', config: currentConfig });
    }
}

function updateTrayMenu() {
    if (!tray) return;

    const isStreaming = (streamStatus === 'streaming');
    const isConnecting = (streamStatus === 'connecting');

    // Tooltip with live status
    if (isStreaming) {
        const fpsStr = latestStats.fps > 0 ? `${latestStats.fps.toFixed(1)} FPS` : `${currentConfig.fps || 120} Hz`;
        const mbpsStr = latestStats.mbps > 0 ? `${latestStats.mbps.toFixed(1)} Mbps` : `${currentConfig.bitrate || 60} Mbps`;
        tray.setToolTip(`ReDisplay: 正在串流\n• 性能: ${fpsStr} | ${mbpsStr}\n• 规格: ${currentConfig.width || 1752}x${currentConfig.height || 2800}\n• 设备: ${activeStreamDeviceName || activeStreamSerial || '已连接'}`);
    } else if (isConnecting) {
        tray.setToolTip('ReDisplay: 正在建立副屏连接通道...');
    } else {
        tray.setToolTip('ReDisplay: 待机就绪 (双击打开控制台)');
    }

    const template = [];

    // 1. Dynamic Status Header (Informational, non-clickable)
    if (isStreaming) {
        const fpsStr = latestStats.fps > 0 ? `${latestStats.fps.toFixed(1)} FPS` : `${currentConfig.fps || 120} Hz`;
        const mbpsStr = latestStats.mbps > 0 ? `${latestStats.mbps.toFixed(1)} Mbps` : `${currentConfig.bitrate || 60} Mbps`;
        template.push({
            label: `● 串流中 · ${fpsStr} · ${mbpsStr}`,
            enabled: false
        });
        template.push({
            label: `   规格: ${currentConfig.width || 1752}×${currentConfig.height || 2800} (${currentConfig.bufferMode === 'smooth' ? '平滑优先' : '极低延迟'})`,
            enabled: false
        });
        if (activeStreamDeviceName || activeStreamSerial) {
            template.push({
                label: `   目标: ${activeStreamDeviceName || activeStreamSerial}`,
                enabled: false
            });
        }
    } else if (isConnecting) {
        template.push({
            label: '⏳ 正在连接安卓设备与启动副屏...',
            enabled: false
        });
    } else {
        template.push({
            label: '○ 副屏服务: 待机就绪',
            enabled: false
        });
    }

    template.push({ type: 'separator' });

    // 2. Primary Service Action
    if (isStreaming) {
        template.push({
            label: '⏹ 停止副屏服务',
            click: () => {
                stopHostProcess();
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('tray-action', { action: 'stop' });
                }
            }
        });
    } else {
        template.push({
            label: '▶ 启动副屏服务',
            click: () => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('tray-action', { action: 'start' });
                } else {
                    startHostProcess(currentConfig);
                }
            }
        });
    }

    // 3. Quick Performance Profile Submenu
    template.push({
        label: '⚡ 性能预设档位',
        submenu: [
            {
                label: '⚡ 极速电竞直通 (120Hz · 60Mbps · ≤10ms)',
                type: 'radio',
                checked: currentConfig.profile === 'esports',
                click: () => sendTrayConfigChange({ profile: 'esports', fps: 120, bitrate: 60, bufferMode: 'lowlatency' })
            },
            {
                label: '🎬 极致超清画质 (120Hz · 85Mbps · 高保真)',
                type: 'radio',
                checked: currentConfig.profile === 'quality',
                click: () => sendTrayConfigChange({ profile: 'quality', fps: 120, bitrate: 85, bufferMode: 'lowlatency' })
            },
            {
                label: '🔋 节能平滑办公 (60Hz · 30Mbps · 平滑)',
                type: 'radio',
                checked: currentConfig.profile === 'office',
                click: () => sendTrayConfigChange({ profile: 'office', fps: 60, bitrate: 30, bufferMode: 'smooth' })
            }
        ]
    });

    // 4. Quick Resolution Submenu
    template.push({
        label: '📐 副屏分辨率与方向',
        submenu: [
            {
                label: '1752 × 2800 (16:10 竖屏 · 2.8K)',
                type: 'radio',
                checked: (currentConfig.width === 1752 && currentConfig.height === 2800),
                click: () => sendTrayConfigChange({ width: 1752, height: 2800, orientation: 'portrait' })
            },
            {
                label: '2800 × 1752 (16:10 横屏 · 2.8K)',
                type: 'radio',
                checked: (currentConfig.width === 2800 && currentConfig.height === 1752),
                click: () => sendTrayConfigChange({ width: 2800, height: 1752, orientation: 'landscape' })
            },
            {
                label: '1600 × 2560 (16:10 竖屏 · 2.5K)',
                type: 'radio',
                checked: (currentConfig.width === 1600 && currentConfig.height === 2560),
                click: () => sendTrayConfigChange({ width: 1600, height: 2560, orientation: 'portrait' })
            },
            {
                label: '2560 × 1600 (16:10 横屏 · 2.5K)',
                type: 'radio',
                checked: (currentConfig.width === 2560 && currentConfig.height === 1600),
                click: () => sendTrayConfigChange({ width: 2560, height: 1600, orientation: 'landscape' })
            },
            {
                label: '1200 × 1920 (16:10 竖屏 · 1200P)',
                type: 'radio',
                checked: (currentConfig.width === 1200 && currentConfig.height === 1920),
                click: () => sendTrayConfigChange({ width: 1200, height: 1920, orientation: 'portrait' })
            },
            {
                label: '1920 × 1200 (16:10 横屏 · 1200P)',
                type: 'radio',
                checked: (currentConfig.width === 1920 && currentConfig.height === 1200),
                click: () => sendTrayConfigChange({ width: 1920, height: 1200, orientation: 'landscape' })
            },
            {
                label: '1080 × 1920 (9:16 竖屏 · 1080P)',
                type: 'radio',
                checked: (currentConfig.width === 1080 && currentConfig.height === 1920),
                click: () => sendTrayConfigChange({ width: 1080, height: 1920, orientation: 'portrait' })
            },
            {
                label: '1920 × 1080 (16:9 横屏 · 1080P)',
                type: 'radio',
                checked: (currentConfig.width === 1920 && currentConfig.height === 1080),
                click: () => sendTrayConfigChange({ width: 1920, height: 1080, orientation: 'landscape' })
            }
        ]
    });

    template.push({ type: 'separator' });

    // 5. Control Center & Windows Display Settings
    template.push({
        label: mainWindow && mainWindow.isVisible() ? '隐藏主控制台' : '显示主控制台',
        click: () => {
            if (mainWindow) {
                if (mainWindow.isVisible()) {
                    mainWindow.hide();
                } else {
                    mainWindow.show();
                    mainWindow.focus();
                }
                updateTrayMenu();
            }
        }
    });

    template.push({
        label: '打开 Windows 显示设置',
        click: () => {
            exec('start ms-settings:display');
        }
    });

    template.push({ type: 'separator' });

    // 6. Exit
    template.push({
        label: '退出 ReDisplay',
        click: () => {
            isQuitting = true;
            stopHostProcess();
            app.quit();
        }
    });

    const contextMenu = Menu.buildFromTemplate(template);
    tray.setContextMenu(contextMenu);
}

function createTray() {
    const iconPath = fs.existsSync(path.join(__dirname, 'assets', 'tray.ico'))
        ? path.join(__dirname, 'assets', 'tray.ico')
        : path.join(__dirname, 'assets', 'tray.png');
    tray = new Tray(iconPath);
    updateTrayMenu();

    tray.on('double-click', () => {
        if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
            updateTrayMenu();
        }
    });
    tray.on('click', () => {
        if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
            updateTrayMenu();
        }
    });

    return updateTrayMenu;
}

// 1. Client APK Check & Installation
function checkClientInstalled(serial) {
    const adb = getAdbPath();
    const cmd = serial ? `"${adb}" -s ${serial} shell pm path com.redisplay.client` : `"${adb}" shell pm path com.redisplay.client`;
    return new Promise((resolve) => {
        exec(cmd, (err, stdout) => {
            const installed = !err && stdout && stdout.includes('package:');
            resolve({ installed });
        });
    });
}

function installClientApk(serial) {
    const adb = getAdbPath();
    const apk = getApkPath();
    if (!apk || !fs.existsSync(apk)) {
        return Promise.resolve({ success: false, error: '未在系统中找到 ReDisplay.apk' });
    }
    const cmd = serial ? `"${adb}" -s ${serial} install -r "${apk}"` : `"${adb}" install -r "${apk}"`;
    return new Promise((resolve) => {
        exec(cmd, (err, stdout, stderr) => {
            const out = (stdout || '') + (stderr || '');
            if (out.includes('Success')) {
                resolve({ success: true, message: '客户端应用安装成功' });
            } else if (out.includes('INSTALL_FAILED_USER_RESTRICTED')) {
                resolve({ success: false, error: '设备限制了USB安装，请在安卓【开发者选项】中开启【USB安装 (允许通过USB安装应用)】' });
            } else {
                resolve({ success: false, error: out.trim() || err?.message || '安装失败' });
            }
        });
    });
}

// 2. Hardware & Device Probing
function detectDeviceSpecs(serial) {
    const adb = getAdbPath();
    const prefix = serial ? `"${adb}" -s ${serial}` : `"${adb}"`;

    return new Promise((resolve) => {
        exec(`${prefix} shell "wm size; dumpsys display | grep -E 'mBaseDisplayInfo|modes|supportedModes'; cat /sys/class/udc/*/current_speed 2>/dev/null"`, (err, stdout) => {
            if (err || !stdout) {
                resolve({ width: 0, height: 0, fps: 60, usbTier: 'USB 链路未知' });
                return;
            }

            let width = 0;
            let height = 0;
            let fps = 60;
            let usbTier = 'USB 2.0 (480Mbps)';

            // Parse wm size
            const sizeMatch = stdout.match(/Physical size:\s*(\d+)x(\d+)/i) || stdout.match(/size:\s*(\d+)x(\d+)/i);
            if (sizeMatch) {
                width = parseInt(sizeMatch[1], 10);
                height = parseInt(sizeMatch[2], 10);
            }

            // Parse FPS
            const fpsMatches = stdout.match(/fps\s*=?\s*(\d+(\.\d+)?)/gi);
            if (fpsMatches) {
                for (const fm of fpsMatches) {
                    const val = parseFloat(fm.replace(/fps\s*=?\s*/i, ''));
                    if (val >= 119) {
                        fps = 120;
                        break;
                    } else if (val >= 89 && fps < 90) {
                        fps = 90;
                    } else if (val >= 59 && fps < 60) {
                        fps = 60;
                    }
                }
            }

            // Parse USB speed
            if (stdout.includes('super-speed-plus')) {
                usbTier = 'USB 3.2 Gen 2 (10Gbps 极速)';
            } else if (stdout.includes('super-speed')) {
                usbTier = 'USB 3.0 / 3.1 (5Gbps 高速)';
            } else if (stdout.includes('high-speed')) {
                usbTier = 'USB 2.0 (480Mbps)';
            }

            resolve({ width, height, fps, usbTier });
        });
    });
}

// 3. USB Benchmark
function testUsbSpeed(serial) {
    const adb = getAdbPath();
    const prefix = serial ? `"${adb}" -s ${serial}` : `"${adb}"`;
    const tmpDir = app.getPath('temp');
    const tmpFile = path.join(tmpDir, 'redisplay_speedtest.bin');

    try {
        const buf = Buffer.alloc(10 * 1024 * 1024, 0xAA);
        fs.writeFileSync(tmpFile, buf);

        const t0 = Date.now();
        return new Promise((resolve) => {
            exec(`${prefix} push "${tmpFile}" /data/local/tmp/speedtest.bin`, (err, stdout, stderr) => {
                const durationSec = (Date.now() - t0) / 1000;
                fs.unlink(tmpFile, () => {});
                exec(`${prefix} shell rm -f /data/local/tmp/speedtest.bin`);

                if (err) {
                    resolve({ success: false, error: err.message });
                    return;
                }

                const out = (stdout || '') + (stderr || '');
                const match = out.match(/([\d.]+)\s*MB\/s/i);
                let speedMBps = match ? parseFloat(match[1]) : (10 / durationSec);
                speedMBps = Math.round(speedMBps * 10) / 10;

                let tier = 'USB 2.0 (480Mbps)';
                if (speedMBps > 300) {
                    tier = 'USB 3.2 Gen 2 (10Gbps 极速)';
                } else if (speedMBps > 80) {
                    tier = 'USB 3.0 / 3.1 (5Gbps 高速)';
                }

                resolve({ success: true, speedMBps, tier });
            });
        });
    } catch (e) {
        return Promise.resolve({ success: false, error: e.message });
    }
}

// 4. Driver Management
function manageDriver(action) {
    const batPath = getDriverScriptPath(action);
    if (!batPath || !fs.existsSync(batPath)) {
        return Promise.resolve({ success: false, error: `未找到驱动脚本文件` });
    }

    return new Promise((resolve) => {
        const batDir = path.dirname(batPath);
        const psCmd = `Start-Process -FilePath "cmd.exe" -ArgumentList "/c cd /d ""${batDir}"" && ""${batPath}""" -Verb RunAs -Wait`;
        exec(`powershell -Command "${psCmd}"`, (err) => {
            if (err) {
                resolve({ success: false, error: '用户取消提权或驱动执行失败' });
            } else {
                resolve({ success: true, message: action === 'uninstall' ? '驱动卸载已执行' : '驱动安装已成功完成' });
            }
        });
    });
}

// 5. Host Process Management (100% Invisible, No Console Window)
async function startHostProcess(config) {
    if (hostProcess) {
        try { hostProcess.kill('SIGINT'); } catch (e) {}
        hostProcess = null;
    }

    streamStatus = 'connecting';
    currentConfig = { ...currentConfig, ...config };
    updateTrayMenu();
    const exePath = getHostExePath();

    // Auto-check and auto-install client APK if not installed
    if (config.serial) {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('stream-event', {
                type: 'state',
                status: 'connecting',
                message: '检查安卓端客户端应用...'
            });
        }
        const checkRes = await checkClientInstalled(config.serial);
        if (!checkRes.installed) {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('stream-event', {
                    type: 'state',
                    status: 'connecting',
                    message: '客户端未安装，正在自动向设备部署 ReDisplay.apk...'
                });
            }
            const installRes = await installClientApk(config.serial);
            if (!installRes.success) {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('stream-event', {
                        type: 'state',
                        status: 'error',
                        message: `自动安装客户端失败: ${installRes.error}`
                    });
                }
                streamStatus = 'idle';
                updateTrayMenu();
                return { success: false, error: installRes.error };
            }
        }
    }

    const args = ['--gui'];
    if (config.display !== undefined && config.display !== null && config.display !== '') {
        args.push('--display', String(config.display));
    }
    if (config.fps) {
        args.push('--fps', String(config.fps));
    }
    if (config.bitrate) {
        args.push('--bitrate', String(config.bitrate));
    }
    if (config.width) {
        args.push('--width', String(config.width));
    }
    if (config.height) {
        args.push('--height', String(config.height));
    }
    if (config.bufferMode) {
        args.push('--buffer-mode', String(config.bufferMode));
    }
    if (config.serial) {
        args.push('--serial', String(config.serial));
    }
    if (config.port) {
        args.push('--port', String(config.port));
    }

    activeStreamSerial = config.serial || '';
    console.log('[Host] Spawning silently:', exePath, args.join(' '));

    try {
        hostProcess = spawn(exePath, args, {
            cwd: path.dirname(exePath),
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        const rl = readline.createInterface({
            input: hostProcess.stdout,
            terminal: false
        });

        rl.on('line', (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            try {
                const data = JSON.parse(trimmed);
                if (data.type === 'state') {
                    if (data.status === 'streaming') {
                        streamStatus = 'streaming';
                        updateTrayMenu();
                    } else if (data.status === 'connecting' || data.status === 'launching_app') {
                        streamStatus = 'connecting';
                        updateTrayMenu();
                    }
                } else if (data.type === 'device_selected') {
                    activeStreamDeviceName = data.model || '';
                    activeStreamSerial = data.serial || '';
                    updateTrayMenu();
                } else if (data.type === 'stats') {
                    latestStats = {
                        fps: data.fps || 0,
                        mbps: data.mbps || 0,
                        encodeMs: data.encodeMs || 0,
                        dropped: data.dropped || 0,
                        frames: data.frames || 0
                    };
                    const now = Date.now();
                    if (now - lastTrayUpdateTime > 1500) {
                        lastTrayUpdateTime = now;
                        updateTrayMenu();
                    }
                }
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('stream-event', data);
                }
            } catch (e) {
                console.log('[Host stdout]', trimmed);
            }
        });

        hostProcess.stderr.on('data', (data) => {
            console.error('[Host stderr]', data.toString());
        });

        hostProcess.on('exit', (code, signal) => {
            console.log(`[Host] Process exited with code ${code}`);
            hostProcess = null;
            streamStatus = 'idle';
            latestStats = { fps: 0, mbps: 0, encodeMs: 0, dropped: 0, frames: 0 };
            updateTrayMenu();
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('stream-status', { status: 'stopped', code });
            }
        });

        hostProcess.on('error', (err) => {
            console.error('[Host] Failed to spawn:', err);
            hostProcess = null;
            streamStatus = 'idle';
            latestStats = { fps: 0, mbps: 0, encodeMs: 0, dropped: 0, frames: 0 };
            updateTrayMenu();
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('stream-status', { status: 'error', message: err.message });
            }
        });

        return { success: true };
    } catch (err) {
        streamStatus = 'idle';
        updateTrayMenu();
        return { success: false, error: err.message };
    }
}

function stopHostProcess(serial) {
    console.log('[Host] Stopping secondary display stream...');
    if (hostProcess) {
        try { hostProcess.kill('SIGINT'); } catch (e) {}
        try { hostProcess.kill(); } catch (e) {}
        hostProcess = null;
    }
    streamStatus = 'idle';
    latestStats = { fps: 0, mbps: 0, encodeMs: 0, dropped: 0, frames: 0 };
    updateTrayMenu();

    // Only kill the C++ Host engine (NEVER ReDisplay.exe, which is the GUI application itself!)
    exec('taskkill /F /IM ReDisplayHost.exe >nul 2>&1');

    // Clean up channel and exit Android client application
    const adbPath = getAdbPath();
    const targetSerial = serial || activeStreamSerial || '';
    const adbCmd = targetSerial ? `"${adbPath}" -s ${targetSerial}` : `"${adbPath}"`;

    exec(`${adbCmd} forward --remove tcp:27183 >nul 2>&1`);
    exec(`${adbCmd} shell am force-stop com.redisplay.client >nul 2>&1`);
    console.log('[Host] Stream channel cleared and Android client stopped.');

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('stream-status', { status: 'stopped' });
    }
    return { success: true };
}

let isRestarting = false;

async function restartHostProcess(config) {
    if (isRestarting) {
        console.log('[Host] Restart already in progress, waiting...');
    }
    isRestarting = true;
    try {
        console.log('[Host] Performing atomic hot-restart of secondary display...');
        
        // 1. Terminate running host process
        if (hostProcess) {
            try { hostProcess.kill('SIGINT'); } catch (e) {}
            try { hostProcess.kill('SIGTERM'); } catch (e) {}
            hostProcess = null;
        }

        // 2. Synchronously ensure old ReDisplayHost.exe is dead
        try {
            execSync('taskkill /F /IM ReDisplayHost.exe >nul 2>&1');
        } catch (e) {}

        // Small grace period for Windows sockets/D3D cleanup
        await new Promise(r => setTimeout(r, 250));

        // 3. Start new host process with new parameters
        return await startHostProcess(config);
    } finally {
        isRestarting = false;
    }
}

// Single instance enforcement
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });

    app.whenReady().then(() => {
        createWindow();
        createTray();

        // Window controls
        ipcMain.on('window-minimize', () => mainWindow?.minimize());
        ipcMain.on('window-maximize', () => {
            if (mainWindow?.isMaximized()) {
                mainWindow.unmaximize();
            } else {
                mainWindow?.maximize();
            }
        });
        ipcMain.on('window-close', () => mainWindow?.close());
        ipcMain.on('window-hide-to-tray', () => mainWindow?.hide());
        ipcMain.on('config-changed', (event, newConfig) => {
            currentConfig = { ...currentConfig, ...newConfig };
            updateTrayMenu();
        });

        // Stream IPC
        ipcMain.handle('start-stream', (event, config) => startHostProcess(config));
        ipcMain.handle('stop-stream', (event, serial) => stopHostProcess(serial));
        ipcMain.handle('restart-stream', async (event, config) => restartHostProcess(config));
        ipcMain.handle('get-service-status', () => ({ running: !!hostProcess }));

        // Hardware & Displays
        ipcMain.handle('get-displays', async () => {
            const exePath = getHostExePath();
            return new Promise((resolve) => {
                execFile(exePath, ['--list-displays'], { cwd: path.dirname(exePath) }, (err, stdout) => {
                    if (err || !stdout) {
                        resolve([]);
                        return;
                    }
                    try {
                        const lines = stdout.split(/\r?\n/);
                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (trimmed.startsWith('{') && trimmed.includes('"displays"')) {
                                const data = JSON.parse(trimmed);
                                resolve(data.displays || []);
                                return;
                            }
                        }
                        const data = JSON.parse(stdout.trim());
                        resolve(data.displays || []);
                    } catch (e) {
                        resolve([]);
                    }
                });
            });
        });

        ipcMain.handle('get-devices', async () => {
            const exePath = getHostExePath();
            return new Promise((resolve) => {
                execFile(exePath, ['--list-devices'], { cwd: path.dirname(exePath) }, (err, stdout) => {
                    if (err || !stdout) {
                        resolve([]);
                        return;
                    }
                    try {
                        const lines = stdout.split(/\r?\n/);
                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (trimmed.startsWith('{') && trimmed.includes('"devices"')) {
                                const data = JSON.parse(trimmed);
                                resolve(data.devices || []);
                                return;
                            }
                        }
                        const data = JSON.parse(stdout.trim());
                        resolve(data.devices || []);
                    } catch (e) {
                        resolve([]);
                    }
                });
            });
        });

        ipcMain.handle('get-gpu-info', async () => {
            const exePath = getHostExePath();
            return new Promise((resolve) => {
                execFile(exePath, ['--list-displays'], { cwd: path.dirname(exePath) }, (err, stdout) => {
                    if (!err && stdout) {
                        try {
                            const data = JSON.parse(stdout.trim());
                            if (data.displays) {
                                for (const d of data.displays) {
                                    if (d.adapter && !d.adapter.includes('Virtual') && !d.adapter.includes('Microsoft')) {
                                        resolve({ gpuName: d.adapter });
                                        return;
                                    }
                                }
                            }
                        } catch (e) {}
                    }
                    resolve({ gpuName: 'NVIDIA GeForce GPU' });
                });
            });
        });

        // Device Probing & Benchmarking
        ipcMain.handle('check-client-installed', (event, serial) => checkClientInstalled(serial));
        ipcMain.handle('install-client-apk', (event, serial) => installClientApk(serial));
        ipcMain.handle('detect-device-specs', (event, serial) => detectDeviceSpecs(serial));
        ipcMain.handle('test-usb-speed', (event, serial) => testUsbSpeed(serial));

        // Driver & Windows Settings
        ipcMain.handle('check-driver-status', () => {
            const xmlPath = 'C:\\VirtualDisplayDriver\\vdd_settings.xml';
            return fs.existsSync(xmlPath);
        });
        ipcMain.handle('manage-driver', (event, action) => manageDriver(action));
        ipcMain.handle('open-display-settings', () => {
            exec('start ms-settings:display');
            return true;
        });
    });

    app.on('before-quit', () => {
        isQuitting = true;
        stopHostProcess();
    });

    app.on('window-all-closed', () => {});
}

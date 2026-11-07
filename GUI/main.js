const { app, BrowserWindow, ipcMain, Tray, Menu } = require('electron');
const path = require('path');
const { translate } = require('./i18n');
let language = 'zh-CN';
const t = (key, values) => translate(language, key, values);
const { spawn, execFile, exec } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const { randomBytes } = require('crypto');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const CLIENT_PACKAGE = 'com.redisplay.client.demo';

let mainWindow = null;
let tray = null;
let hostProcess = null;
let isQuitting = false;
let quitRequested = false;
let requestId = 0;
let hostShutdown = Promise.resolve();
let currentConfig = {
    profile: 'esports',
    fps: 180,
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
        path.join(__dirname, '..', 'scratch', 'demo', 'bin', 'ReDisplayHost.exe'),
        path.join(__dirname, 'bin', 'ReDisplayHost.exe'),
        path.join(__dirname, 'ReDisplayHost.exe')
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return candidates[0];
}

function getAdbPath() {
    const candidates = [
        path.join(__dirname, '..', 'bin', 'adb.exe'),
        path.join(__dirname, 'resources', 'bin', 'adb.exe'),
        path.join(__dirname, '..', 'resources', 'bin', 'adb.exe'),
        ...(process.env.REDISPLAY_ADB ? [process.env.REDISPLAY_ADB] : []),
        ...[process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter(Boolean)
            .map(sdk => path.join(sdk, 'platform-tools', 'adb.exe')),
        path.join(__dirname, '..', 'Release', 'Archive', 'ReDisplay-Win64', 'resources', 'bin', 'adb.exe'),
        'C:\\Program Files\\QtScrcpy-win-x64-v3.2.0\\adb.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe')
    ];
    candidates.push(...(process.env.PATH || '').split(path.delimiter).filter(Boolean)
        .map(dir => path.join(dir.replace(/^"|"$/g, ''), 'adb.exe')));
    for (const p of candidates) {
        if (fs.existsSync(p)) return path.resolve(p);
    }
    return '';
}

function getApkPath() {
    const candidates = [
        path.join(__dirname, '..', 'scratch', 'demo', 'Client', 'ReDisplay.apk'),
        ...(path.basename(path.dirname(__dirname)) === 'resources' ? [path.join(__dirname, '..', 'Client', 'ReDisplay.apk')] : []),
        path.join(__dirname, 'resources', 'Client', 'ReDisplay.apk'),
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
        title: 'ReDisplay',
        width: 840,
        height: 590,
        minWidth: 660,
        minHeight: 480,
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
                        title: t('ReDisplay 已隐藏至托盘'),
                        content: t('双击托盘图标重新打开。')
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

    const streaming = streamStatus === 'streaming';
    const active = streamStatus !== 'idle';
    const status = t(streaming ? '串流中' : active ? '正在连接' : '待机就绪');
    const fps = (latestStats.fps ?? currentConfig.fps).toFixed(1) + ' FPS';
    const bitrate = (latestStats.mbps ?? currentConfig.bitrate).toFixed(1) + ' Mbps';
    const headline = streaming ? status + ' · ' + fps + ' · ' + bitrate : status;
    tray.setToolTip('ReDisplay · ' + headline);

    const profiles = [
        { profile: 'esports', name: '高帧率', fps: 180, bitrate: 60, bufferMode: 'lowlatency' },
        { profile: 'quality', name: '高画质', fps: 120, bitrate: 85, bufferMode: 'lowlatency' },
        { profile: 'office', name: '低码率', fps: 60, bitrate: 30, bufferMode: 'smooth' }
    ];
    const resolutions = [
        [1752, 2800], [2800, 1752], [1600, 2560], [2560, 1600],
        [1200, 1920], [1920, 1200], [1080, 1920], [1920, 1080]
    ];
    const template = [{ label: headline, enabled: false }];
    if (streaming) {
        const width = currentConfig.actualWidth || currentConfig.width;
        const height = currentConfig.actualHeight || currentConfig.height;
        template.push({
            label: width + ' × ' + height + ' · ' + t(currentConfig.bufferMode === 'smooth' ? '平滑优先' : '低延迟'),
            enabled: false
        });
        const device = activeStreamDeviceName || activeStreamSerial;
        if (device) template.push({ label: device, enabled: false });
    }

    template.push(
        { type: 'separator' },
        {
            label: t(active ? '停止副屏服务' : '启动副屏服务'),
            click: () => {
                if (active) stopHostProcess();
                else if (mainWindow && !mainWindow.isDestroyed()) sendToWindow('tray-action', { action: 'start' });
                else startHostProcess(currentConfig);
            }
        },
        {
            label: t('串流预设'),
            submenu: profiles.map(({ name, ...config }) => ({
                label: t(name) + ' · ' + config.fps + ' FPS / ' + config.bitrate + ' Mbps',
                type: 'radio',
                checked: currentConfig.profile === config.profile,
                click: () => sendTrayConfigChange(config)
            }))
        },
        {
            label: t('副屏分辨率'),
            submenu: resolutions.map(([width, height]) => ({
                label: width + ' × ' + height + ' · ' + t(height > width ? '竖屏' : '横屏'),
                type: 'radio',
                checked: currentConfig.width === width && currentConfig.height === height,
                click: () => sendTrayConfigChange({ width, height, orientation: height > width ? 'portrait' : 'landscape' })
            }))
        },
        { type: 'separator' },
        {
            label: t(mainWindow?.isVisible() ? '隐藏主控制台' : '显示主控制台'),
            click: () => {
                if (!mainWindow) return;
                if (mainWindow.isVisible()) mainWindow.hide();
                else {
                    mainWindow.show();
                    mainWindow.focus();
                }
                updateTrayMenu();
            }
        },
        { label: t('打开 Windows 显示设置'), click: () => exec('start ms-settings:display') },
        { type: 'separator' },
        { label: t('退出 ReDisplay'), click: () => app.quit() }
    );
    tray.setContextMenu(Menu.buildFromTemplate(template));
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

function sendToWindow(channel, data) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

async function runAdb(serial, args, timeout = 10000) {
    const adb = getAdbPath();
    if (!adb) throw new Error(t('未找到 ADB'));
    return execFileAsync(adb, [...(serial ? ['-s', serial] : []), ...args], { timeout, windowsHide: true });
}

function hostOptions() {
    return {
        cwd: path.dirname(getHostExePath()),
        env: { ...process.env, REDISPLAY_ADB: getAdbPath() },
        windowsHide: true,
        timeout: 8000
    };
}

async function queryHost(arg, key) {
    try {
        const { stdout } = await execFileAsync(getHostExePath(), [arg], hostOptions());
        return JSON.parse(stdout.trim())[key] || [];
    } catch {
        return [];
    }
}

async function checkClientInstalled(serial) {
    try {
        const { stdout } = await runAdb(serial, ['shell', 'pm', 'path', CLIENT_PACKAGE]);
        return { installed: stdout.includes('package:') };
    } catch (e) {
        if (e.code === 1 && !e.stderr?.trim() && !e.stdout?.trim()) return { installed: false };
        return { installed: false, error: e.stderr?.trim() || e.message };
    }
}

async function installClientApk(serial) {
    const apk = getApkPath();
    if (!apk) return { success: false, error: t('未找到 Android APK。') };
    try {
        await runAdb(serial, ['install', '-r', apk], 90000);
        return { success: true, message: t('Android 应用安装成功') };
    } catch (e) {
        return { success: false, error: e.stderr?.trim() || e.stdout?.trim() || e.message };
    }
}

async function detectDeviceSpecs(serial) {
    const unknown = { width: 0, height: 0, fps: 60, usbTier: 'USB 链路未知' };
    try {
        const { stdout } = await runAdb(serial, ['shell',
            "wm size; dumpsys display | grep 'DisplayDeviceInfo'; cat /sys/class/udc/*/current_speed 2>/dev/null; true"]);
        const size = stdout.match(/Physical size:\s*(\d+)x(\d+)/i);
        const internalDisplay = stdout.split(/\r?\n/).find(line => line.includes('type INTERNAL')) || '';
        const modeRates = [...internalDisplay.matchAll(/\bfps[=:]\s*(\d+(?:\.\d+)?)/g)].map(m => Number(m[1]));
        let usbTier = unknown.usbTier;
        if (/^super-speed-plus\s*$/m.test(stdout)) usbTier = 'USB SuperSpeedPlus';
        else if (/^super-speed\s*$/m.test(stdout)) usbTier = 'USB SuperSpeed (5 Gbps)';
        else if (/^high-speed\s*$/m.test(stdout)) usbTier = 'USB High-Speed (480 Mbps)';
        else if (/^full-speed\s*$/m.test(stdout)) usbTier = 'USB Full-Speed (12 Mbps)';
        return { width: Number(size?.[1] || 0), height: Number(size?.[2] || 0),
            fps: Math.round(Math.max(60, ...modeRates)), usbTier };
    } catch {
        return unknown;
    }
}

async function testUsbSpeed(serial) {
    let dir;
    const suffix = randomBytes(8).toString('hex');
    const remote = '/data/local/tmp/redisplay-' + suffix + '.bin';
    const bytes = 10 * 1024 * 1024;
    try {
        dir = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'redisplay-'));
        const file = path.join(dir, 'speedtest.bin');
        await fs.promises.writeFile(file, await promisify(randomBytes)(bytes));
        const started = process.hrtime.bigint();
        await runAdb(serial, ['push', '-Z', file, remote], 30000);
        const seconds = Number(process.hrtime.bigint() - started) / 1e9;
        const speedMBps = Math.round(bytes / seconds / 100000) / 10;
        const estimatedTier = speedMBps > 300 ? 'USB 3.2 Gen 2 档' : speedMBps > 80 ? 'USB 3.0 档' : 'USB 2.0 档';
        return { success: true, speedMBps, estimatedTier };
    } catch (e) {
        return { success: false, error: e.stderr?.trim() || e.message };
    } finally {
        if (dir) {
            await Promise.allSettled([
                fs.promises.unlink(path.join(dir, 'speedtest.bin')).finally(() => fs.promises.rmdir(dir)),
                runAdb(serial, ['shell', 'rm', '-f', remote])
            ]);
        }
    }
}

async function checkDriverStatus() {
    try {
        const { stdout } = await execFileAsync(getHostExePath(), ['--driver-status'], hostOptions());
        return stdout.trim() === 'true';
    } catch {
        return false;
    }
}

async function manageDriver(action) {
    if (action !== 'install' && action !== 'uninstall') return { success: false, error: t('无效的驱动操作') };
    const batPath = getDriverScriptPath(action);
    if (!batPath) return { success: false, error: t('未找到驱动脚本文件') };
    try {
        await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            '$p = Start-Process -FilePath $env:REDISPLAY_DRIVER_SCRIPT -ArgumentList "--quiet" -Verb RunAs -WindowStyle Hidden -PassThru -Wait -ErrorAction Stop; exit $p.ExitCode'
        ], { env: { ...process.env, REDISPLAY_DRIVER_SCRIPT: batPath }, windowsHide: true });
        const active = await checkDriverStatus();
        if (active !== (action === 'install')) return { success: false, error: t('驱动状态未达到预期，请检查 Windows 设备管理器。') };
        return { success: true };
    } catch (e) {
        return { success: false, error: t('驱动操作未完成（{error}）', { error: e.code || e.message }) };
    }
}

function releaseHost() {
    const child = hostProcess;
    if (!child) return hostShutdown;
    hostProcess = null;
    hostShutdown = new Promise(resolve => {
        const timer = setTimeout(() => child.kill(), 12000);
        child.once('close', () => {
            clearTimeout(timer);
            resolve();
        });
        child.stdin.end();
    });
    return hostShutdown;
}

async function startHostProcess(config) {
    const id = ++requestId;
    streamStatus = 'connecting';
    updateTrayMenu();
    await releaseHost();
    if (id !== requestId || quitRequested) return { success: false, cancelled: true };

    currentConfig = { ...currentConfig, ...config };
    const exe = getHostExePath();
    const failed = error => {
        if (id !== requestId) return { success: false, cancelled: true };
        streamStatus = 'idle';
        updateTrayMenu();
        return { success: false, error };
    };
    if (!fs.existsSync(exe)) return failed(t('未找到 Host，请构建 Host 或运行完整发行包。'));
    if (!getAdbPath()) return failed(t('未找到 ADB'));

    const devices = config.serial ? [] : await queryHost('--list-devices', 'devices');
    if (id !== requestId || quitRequested) return { success: false, cancelled: true };
    const serial = config.serial || (devices.find(d => d.is_tablet) || devices[0])?.serial;
    if (!serial) return failed(t('请连接并授权 Android 设备，然后刷新设备列表。'));

    const check = await checkClientInstalled(serial);
    if (id !== requestId || quitRequested) return { success: false, cancelled: true };
    if (!check.installed) {
        sendToWindow('stream-event', { type: 'state', status: 'connecting', phase: 'installing', message: t('正在安装 Android 应用') });
        const installed = await installClientApk(serial);
        if (id !== requestId || quitRequested) return { success: false, cancelled: true };
        if (!installed.success) return failed(installed.error);
        sendToWindow('client-installed', serial);
    }

    const args = ['--gui', '--serial', serial, '--display', String(config.display ?? -1)];
    if (config.displayName) args.push('--display-name', config.displayName);
    for (const [key, flag] of Object.entries({ fps: 'fps', bitrate: 'bitrate', width: 'width', height: 'height',
        bufferMode: 'buffer-mode', port: 'port' })) {
        if (config[key] !== undefined && config[key] !== null) args.push('--' + flag, String(config[key]));
    }
    if (config.autoReconnect === false) args.push('--no-reconnect');
    activeStreamSerial = serial;
    activeStreamDeviceName = '';
    latestStats = {};
    const options = hostOptions();
    const child = spawn(exe, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    hostProcess = child;
    child.stdin.on('error', () => {});
    const rl = readline.createInterface({ input: child.stdout, terminal: false });
    rl.on('line', line => {
        if (hostProcess !== child) return;
        let data;
        try { data = JSON.parse(line); } catch { return; }
        if (data.type === 'state') {
            if (data.status === 'streaming') {
                streamStatus = 'streaming';
                currentConfig = { ...currentConfig, actualWidth: data.width, actualHeight: data.height };
            } else if (data.status !== 'mode_warning') {
                streamStatus = 'connecting';
            }
            updateTrayMenu();
        } else if (data.type === 'device_selected') {
            activeStreamDeviceName = data.model || '';
            activeStreamSerial = data.serial || serial;
            updateTrayMenu();
        } else if (data.type === 'stats') {
            latestStats = data;
            if (Date.now() - lastTrayUpdateTime > 1500) {
                lastTrayUpdateTime = Date.now();
                updateTrayMenu();
            }
        }
        sendToWindow('stream-event', data);
    });
    child.stderr.on('data', data => console.error('[Host]', data.toString()));
    child.once('error', error => {
        if (hostProcess !== child) return;
        failed(error.message);
        sendToWindow('stream-status', { status: 'error', message: error.message });
    });
    child.once('close', code => {
        if (hostProcess !== child) return;
        hostProcess = null;
        activeStreamSerial = '';
        activeStreamDeviceName = '';
        streamStatus = 'idle';
        latestStats = {};
        updateTrayMenu();
        sendToWindow('stream-status', { status: code ? 'error' : 'stopped', code,
            message: code ? t('Host 退出，代码 {code}', { code }) : undefined });
    });
    return { success: true };
}

async function stopHostProcess() {
    const id = ++requestId;
    const serial = activeStreamSerial;
    activeStreamSerial = '';
    activeStreamDeviceName = '';
    const stopped = releaseHost();
    hostShutdown = stopped.then(async () => {
        if (serial) {
            try { await runAdb(serial, ['shell', 'am', 'force-stop', CLIENT_PACKAGE], 3000); } catch {}
        }
    });
    await hostShutdown;
    if (id === requestId) {
        streamStatus = 'idle';
        latestStats = {};
        updateTrayMenu();
        sendToWindow('stream-status', { status: 'stopped' });
    }
    return { success: true };
}

// Keep release preferences under a stable application profile.
app.setName('ReDisplay');
const profileDirectory = path.join(app.getPath('appData'), 'ReDisplay');
fs.mkdirSync(profileDirectory, { recursive: true });
app.setPath('userData', profileDirectory);
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
        ipcMain.on('set-language', (event, value) => {
            if (event.sender !== mainWindow?.webContents || !['zh-CN', 'en'].includes(value)) return;
            language = value;
            updateTrayMenu();
        });
        ipcMain.on('config-changed', (event, newConfig) => {
            currentConfig = { ...currentConfig, ...newConfig };
            updateTrayMenu();
        });

        // Stream IPC
        ipcMain.handle('start-stream', (event, config) => startHostProcess(config));
        ipcMain.handle('stop-stream', () => stopHostProcess());
        ipcMain.handle('restart-stream', (event, config) => startHostProcess(config));
        ipcMain.handle('get-service-status', () => ({ running: !!hostProcess }));

        ipcMain.handle('get-displays', () => queryHost('--list-displays', 'displays'));
        ipcMain.handle('get-devices', () => queryHost('--list-devices', 'devices'));
        ipcMain.handle('get-gpu-info', async () => {
            const displays = await queryHost('--list-displays', 'displays');
            const display = displays.find(d => !d.isVirtual && d.adapter?.includes('NVIDIA'));
            return { gpuName: display?.adapter || t('未识别到活动的 NVIDIA 显卡') };
        });

        // Device Probing & Benchmarking
        ipcMain.handle('check-client-installed', (event, serial) => checkClientInstalled(serial));
        ipcMain.handle('install-client-apk', (event, serial) => installClientApk(serial));
        ipcMain.handle('detect-device-specs', (event, serial) => detectDeviceSpecs(serial));
        ipcMain.handle('test-usb-speed', (event, serial) => testUsbSpeed(serial));

        // Driver & Windows Settings
        ipcMain.handle('check-driver-status', checkDriverStatus);
        ipcMain.handle('manage-driver', (event, action) => manageDriver(action));
        ipcMain.handle('open-display-settings', () => {
            exec('start ms-settings:display');
            return true;
        });
    });

    app.on('before-quit', event => {
        if (isQuitting) return;
        event.preventDefault();
        if (quitRequested) return;
        quitRequested = true;
        stopHostProcess().finally(() => {
            isQuitting = true;
            app.quit();
        });
    });

    app.on('window-all-closed', () => {});
}

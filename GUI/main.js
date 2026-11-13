const { app, BrowserWindow, ipcMain, Tray, Menu, dialog, powerMonitor } = require('electron');
const path = require('path');
const os = require('os');
const profiles = require('./profiles');
const { summarizeTrace, parseLayerLatency, summarizePresentation } = require('./telemetry');
const { version, clientVersion = version } = require('./package.json');
const { translate } = require('./i18n');
let language = 'zh-CN';
const t = (key, values) => translate(language, key, values);
const { spawn, execFile, exec } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const { randomBytes } = require('crypto');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const CLIENT_PACKAGE = 'com.redisplay.client.v120demo';
const MAX_HOST_SAMPLES = 1800;
const MAX_CLIENT_SAMPLES = 900;

let mainWindow = null;
let tray = null;
let hostProcess = null;
let driverChanging = false;
let isQuitting = false;
let quitRequested = false;
let requestId = 0;
let hostShutdown = Promise.resolve();
let currentConfig = {
    profile: 'balanced',
    fps: 180,
    bitrate: 60,
    width: 1920,
    height: 1080,
    bufferMode: 'lowlatency',
    orientation: 'landscape'
};
let latestStats = { fps: 0, mbps: 0, encodeMs: 0, dropped: 0, frames: 0 };
let streamStatus = 'idle'; // 'idle', 'connecting', 'streaming'
let activeStreamDeviceName = '';
let activeStreamSerial = '';
let hasShownTrayTip = false;
let lastTrayUpdateTime = 0;
let performanceReport = null;
let lastReport = null;
let activeHostConfig;
let suspendedStream;

// Dynamic Path Resolution
function getHostExePath() {
    const candidates = [
        path.join(__dirname, '..', 'bin', 'ReDisplayHost.exe'),
        path.join(__dirname, 'resources', 'bin', 'ReDisplayHost.exe'),
        path.join(__dirname, '..', 'scratch', 'release-v120', 'bin', 'ReDisplayHost.exe'),
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
        ...(process.env.REDISPLAY_ADB ? [process.env.REDISPLAY_ADB] : []),
        path.join(__dirname, '..', 'bin', 'adb.exe'),
        path.join(__dirname, 'resources', 'bin', 'adb.exe'),
        path.join(__dirname, '..', 'resources', 'bin', 'adb.exe'),
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
        path.join(__dirname, '..', 'scratch', 'release-v120', 'Client', 'ReDisplay.apk'),
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
    const scriptName = action === 'uninstall' ? 'uninstall_driver.bat' : 'install_driver.ps1';
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
        title: 'ReDisplay 1.2',
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
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (streamStatus !== 'idle') {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    }
    sendToWindow('tray-action', { action: 'change-config', config: patch });
}

function updateTrayMenu() {
    if (!tray) return;

    const streaming = streamStatus === 'streaming';
    const active = streamStatus !== 'idle';
    const status = t(streaming ? '串流中' : active ? '正在连接' : '待机就绪');
    const headline = streaming && Number.isFinite(latestStats.fps)
        ? status + ' · ' + t('发送 {fps} FPS', { fps: latestStats.fps.toFixed(1) }) + ' · ' + latestStats.mbps.toFixed(1) + ' Mbps'
        : status;
    tray.setToolTip('ReDisplay · ' + headline);

    const resolutions = [[currentConfig.width, currentConfig.height],
        ...(currentConfig.resolutions || [])];
    const uniqueResolutions = new Map(resolutions.map(size => [size.join('x'), size]));
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
            submenu: Object.entries(profiles).map(([profile, { name }]) => ({
                label: t(name),
                type: 'radio',
                checked: currentConfig.profile === profile,
                click: () => sendTrayConfigChange({ profile })
            }))
        },
        {
            label: t('副屏分辨率'),
            submenu: [...uniqueResolutions.values()].map(([width, height]) => ({
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

async function getDeviceStates() {
    try {
        const { stdout } = await runAdb('', ['devices', '-l']);
        const states = stdout.split(/\r?\n/).map(line => line.match(/^\S+\s+(device|unauthorized|offline)\b/))
            .filter(Boolean).map(match => match[1]);
        return { states };
    } catch (error) {
        return { states: [], error: error.stderr?.trim() || error.message };
    }
}

async function checkClientInstalled(serial) {
    try {
        const { stdout } = await runAdb(serial, ['shell', 'dumpsys', 'package', CLIENT_PACKAGE]);
        const installedVersion = stdout.match(/^\s*versionName=(\S+)/m)?.[1];
        return { installed: Boolean(installedVersion), version: installedVersion,
            update: Boolean(installedVersion && installedVersion !== clientVersion) };
    } catch (e) {
        return { installed: false, error: e.stderr?.trim() || e.message };
    }
}

async function installClientApk(serial) {
    const apk = getApkPath();
    if (!apk) return { success: false, error: t('未找到 Android APK。') };
    try {
        await runAdb(serial, ['install', '--no-incremental', '-r', apk], 90000);
        return { success: true, message: t('Android 应用安装成功') };
    } catch (e) {
        const detail = e.stderr?.trim() || e.stdout?.trim() || e.message;
        if (detail.includes('INSTALL_FAILED_USER_RESTRICTED')) {
            return { success: false, error: t('请在 Android 上确认通过 USB 安装，然后重试。') };
        }
        if (detail.includes('INSTALL_FAILED_UPDATE_INCOMPATIBLE')) {
            return { success: false, error: t('Android 已安装不同签名的版本。请使用原签名构建，或在设备上卸载旧版后重试。') };
        }
        return { success: false, error: detail };
    }
}

async function detectDeviceSpecs(serial) {
    const unknown = { width: 0, height: 0, fps: 0, usbTier: 'USB 链路未知' };
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
            fps: Math.round(Math.max(0, ...modeRates)), usbTier };
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
        const speedMbps = bytes * 8 / seconds / 1_000_000;
        return { success: true, speedMbps };
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

async function getDriverInfo() {
    try {
        const { stdout } = await execFileAsync(getHostExePath(), ['--driver-info'], hostOptions());
        return JSON.parse(stdout);
    } catch {
        return { present: false, started: false, version: '' };
    }
}

async function checkDriverStatus() {
    return (await getDriverInfo()).started;
}

async function manageDriver(action, selectedSerial) {
    if (!['install', 'update', 'uninstall'].includes(action)) return { success: false, error: t('无效的驱动操作') };
    if (driverChanging || streamStatus !== 'idle' || hostProcess) {
        return { success: false, error: t('请先停止串流，再更新虚拟显示驱动。') };
    }
    const script = getDriverScriptPath(action);
    if (!script) return { success: false, error: t('未找到驱动脚本文件') };
    driverChanging = true;
    try {
        let native = null;
        if (action !== 'uninstall') {
            const devices = await queryHost('--list-devices', 'devices');
            const device = selectedSerial ? devices.find(d => d.serial === selectedSerial)
                : devices.find(d => d.is_tablet) || devices[0];
            if (device) {
                const { width, height } = await detectDeviceSpecs(device.serial);
                if ([width, height].every(n => Number.isInteger(n) && n >= 2 && n <= 4096 && n % 2 === 0)) {
                    native = { width, height };
                }
            }
            if (action === 'update' && !native) return { success: false, error: t('未读取到设备的可用原生分辨率。') };
        }

        const command = action === 'uninstall'
            ? '$p = Start-Process -FilePath $env:REDISPLAY_DRIVER_SCRIPT -ArgumentList "--quiet" -Verb RunAs -WindowStyle Hidden -PassThru -Wait; exit $p.ExitCode'
            : '$p = Start-Process -FilePath "powershell.exe" -ArgumentList $env:REDISPLAY_DRIVER_ARGS -Verb RunAs -WindowStyle Hidden -PassThru -Wait; exit $p.ExitCode';
        const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', '"' + script + '"'];
        if (native) args.push('-DeviceWidth', String(native.width), '-DeviceHeight', String(native.height));
        if (action === 'update') args.push('-UpdateOnly');
        await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference = "Stop"; ' + command], {
            env: { ...process.env, REDISPLAY_DRIVER_SCRIPT: script, REDISPLAY_DRIVER_ARGS: args.join(' ') }, windowsHide: true
        });
        const active = await checkDriverStatus();
        if (active !== (action !== 'uninstall')) return { success: false, error: t('驱动状态未达到预期，请检查 Windows 设备管理器。') };
        if (native) {
            for (let attempt = 0; attempt < 5; attempt++) {
                const displays = await queryHost('--list-displays', 'displays');
                const modes = displays.filter(display => display.isVirtual).flatMap(display => display.modes || []);
                const hasMode = (width, height) => modes.some(mode => mode.width === width && mode.height === height);
                if (hasMode(native.width, native.height) && hasMode(native.height, native.width)) {
                    return { success: true, native };
                }
                if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 350));
            }
            return { success: false, error: t('已写入设备分辨率，但 Windows 尚未列出对应模式。请检查虚拟屏是否已设为扩展。') };
        }
        return { success: true, native };
    } catch (e) {
        return { success: false, error: t('驱动操作未完成（{error}）', { error: e.code || e.message }) };
    } finally {
        driverChanging = false;
    }
}

function endReport() {
    if (!performanceReport || performanceReport.endedAt) return;
    performanceReport.endedAt = new Date().toISOString();
    if (performanceReport.hostSamples.length) lastReport = performanceReport;
}

function addSample(samples, data, limit) {
    samples.push({ ...data, time: new Date().toISOString() });
    if (samples.length > limit) samples.shift();
}

async function samplePresentation(serial, report) {
    let layer;
    let lastPresent = 0;
    let samples = [];
    let nextSummaryAt = Date.now() + 3000;
    const current = () => performanceReport === report && !report.endedAt;
    while (current()) {
        try {
            if (!layer) {
                const { stdout } = await runAdb(serial, ['shell', 'dumpsys SurfaceFlinger --list'], 2500);
                const entry = stdout.split(/\r?\n/).find(line => line.includes('SurfaceView[') &&
                    line.includes(CLIENT_PACKAGE + '/') && line.includes('(BLAST)'));
                layer = entry?.replace(/^RequestedLayerState\{/, '').split(' parentId=')[0];
            }
            if (layer && current()) {
                const quoted = "'" + layer.replaceAll("'", "'\"'\"'") + "'";
                const { stdout } = await runAdb(serial, ['shell', 'dumpsys SurfaceFlinger --latency ' + quoted], 2500);
                const observed = parseLayerLatency(stdout);
                if (observed.length === 0) layer = null;
                const fresh = observed.filter(point => point[0] > lastPresent);
                if (fresh.length) {
                    lastPresent = Math.max(...fresh.map(point => point[0]));
                    samples.push(...fresh);
                }
            }
        } catch {
            layer = null;
        }
        if (current() && Date.now() >= nextSummaryAt) {
            const result = summarizePresentation(samples);
            if (result.samples > 0) addSample(report.presentation, result, MAX_CLIENT_SAMPLES);
            sendToWindow('stream-event', { type: 'presentation', metrics: result });
            samples = samples.length ? [samples.reduce((last, point) => point[0] > last[0] ? point : last)] : [];
            nextSummaryAt = Date.now() + 3000;
        }
        await new Promise(resolve => setTimeout(resolve, 650));
    }
}

async function sampleGpu(report) {
    const current = () => performanceReport === report && !report.endedAt;
    while (current()) {
        try {
            const { stdout } = await execFileAsync('nvidia-smi.exe', [
                '--query-gpu=index,name,driver_version,utilization.gpu,utilization.encoder,temperature.gpu,memory.used',
                '--format=csv,noheader,nounits'
            ], { timeout: 2500, windowsHide: true });
            if (!current()) return;
            const adapters = stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
                const [index, name, driver, gpu, encoder, temperature, memory] = line.split(',').map(value => value.trim());
                const number = value => value && Number.isFinite(Number(value)) ? Number(value) : null;
                return { index: number(index), name, driver, gpuPercent: number(gpu), encoderPercent: number(encoder),
                    temperatureC: number(temperature), memoryMiB: number(memory) };
            });
            if (adapters.length) {
                addSample(report.gpuSamples, { adapters }, 450);
                sendToWindow('stream-event', { type: 'gpu_stats', adapters });
            }
        } catch {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
}

function collectTrace(report, data) {
    const trace = report.trace;
    if (data.type === 'clock_sync') {
        addSample(trace.clocks, data, 65);
        const summary = summarizeTrace(trace.host.slice(-12), trace.client.slice(-12), trace.clocks.slice(-9));
        sendToWindow('stream-event', { type: 'trace_summary', metrics: summary });
    } else {
        const batches = data.type === 'host_trace' ? trace.host : trace.client;
        batches.push(data.frames);
        if (batches.length > 130) batches.shift();
    }
}

async function exportPerformanceReport() {
    const source = performanceReport?.hostSamples.length ? performanceReport : lastReport;
    if (!source) return { error: t('当前没有可导出的性能数据。') };
    const report = structuredClone(source);
    const now = new Date();
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: t('导出性能报告'),
        defaultPath: `ReDisplay-${version}-${now.toISOString().replaceAll(':', '-')}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled) return { canceled: true };
    try {
        const { stdout } = await execFileAsync('nvidia-smi.exe', [
            '--query-gpu=name,driver_version', '--format=csv,noheader'
        ], { timeout: 3000, windowsHide: true });
        report.windows.nvidiaAdapters = stdout.trim().split(/\r?\n/).filter(Boolean);
    } catch {
        report.windows.nvidiaAdapters = [];
    }
    report.windows.virtualDriver = await getDriverInfo();
    const last = report.hostSamples.at(-1);
    const seconds = report.hostSamples.reduce((total, sample) => total + sample.windowMs, 0) / 1000;
    if (report.trace) {
        report.trace.summary = summarizeTrace(report.trace.host, report.trace.client, report.trace.clocks);
    }
    report.summary = {
        durationSeconds: (Date.parse(report.endedAt ?? now.toISOString()) - Date.parse(report.startedAt)) / 1000,
        sampledSeconds: seconds,
        sentFrames: last.frames,
        sentBytes: last.bytes,
        meanSampledMbps: seconds > 0 ? report.hostSamples.reduce((total, sample) =>
            total + sample.mbps * sample.windowMs / 1000, 0) / seconds : null,
        peakSampledMbps: Math.max(...report.hostSamples.map(sample => sample.mbps)),
        senderDrops: last.dropped,
        wgcSuperseded: last.wgcSuperseded
    };
    try {
        await fs.promises.writeFile(filePath, JSON.stringify(report, null, 2) + '\n', 'utf8');
        return { success: true };
    } catch (error) {
        return { error: error.message };
    }
}

function releaseHost() {
    const child = hostProcess;
    if (!child) return hostShutdown;
    endReport();
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

async function startHostProcess(config, resume = false) {
    if (driverChanging) return { success: false, error: t('正在更新虚拟显示驱动，请稍后再启动。') };
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
    if (!serial) {
        const detected = await getDeviceStates();
        if (detected.error) return failed(t('ADB 检查失败 · {error}', { error: detected.error }));
        if (detected.states.includes('unauthorized')) return failed(t('请在 Android 上允许 USB 调试。'));
        if (detected.states.includes('offline')) return failed(t('ADB 设备离线，请重新连接 USB。'));
        return failed(t('请连接并授权 Android 设备，然后刷新设备列表。'));
    }

    if (!resume) {
        const check = await checkClientInstalled(serial);
        if (id !== requestId || quitRequested) return { success: false, cancelled: true };
        if (check.error) return failed(t('Android 应用检查失败 · {error}', { error: check.error }));
        if (check.update) return failed(t('Android 应用版本不匹配，请在连接页更新。'));
        if (!check.installed) {
            sendToWindow('stream-event', { type: 'state', status: 'connecting', phase: 'installing', message: t('正在安装 Android 应用') });
            const installed = await installClientApk(serial);
            if (id !== requestId || quitRequested) return { success: false, cancelled: true };
            if (!installed.success) return failed(installed.error);
            sendToWindow('client-installed', serial);
        }
    }

    const args = ['--gui', '--serial', serial, '--display', String(config.display ?? -1)];
    if (config.displayName) args.push('--display-name', config.displayName);
    for (const [key, flag] of Object.entries({ fps: 'fps', bitrate: 'bitrate', width: 'width', height: 'height',
        bufferMode: 'buffer-mode', port: 'port', profile: 'profile' })) {
        if (config[key] !== undefined && config[key] !== null) args.push('--' + flag, String(config[key]));
    }
    if (config.autoReconnect === false) args.push('--no-reconnect');
    if (config.trace === true) args.push('--trace');
    activeStreamSerial = serial;
    activeStreamDeviceName = '';
    activeHostConfig = { ...config, serial };
    latestStats = {};
    const options = hostOptions();
    const child = spawn(exe, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    hostProcess = child;
    child.stdin.on('error', () => {});
    const rl = readline.createInterface({ input: child.stdout, terminal: false });
    rl.on('line', line => {
        if (hostProcess !== child) return;
        let data;
        try {
            data = JSON.parse(line);
            if (data.type === 'client_info' || data.type === 'client_stats') {
                data = { type: data.type, metrics: JSON.parse(data.payload) };
                if (!data.metrics || typeof data.metrics !== 'object') return;
            }
        } catch { return; }
        if (data.type === 'state') {
            if (data.status === 'streaming') {
                streamStatus = 'streaming';
                data.trace = config.trace === true;
                latestStats = {};
                performanceReport = {
                    schemaVersion: 2, version, transport: 'ADB forward / TCP',
                    windows: { release: os.release(), version: os.version(), arch: os.arch() },
                    startedAt: new Date().toISOString(), endedAt: null,
                    stream: data, android: null, hostSamples: [], androidSamples: [],
                    presentation: [], gpuSamples: [], trace: config.trace === true ? { host: [], client: [], clocks: [] } : null
                };
                if (performanceReport.trace) {
                    void samplePresentation(serial, performanceReport);
                    void sampleGpu(performanceReport);
                }
                currentConfig = { ...currentConfig, actualWidth: data.width, actualHeight: data.height };
            } else if (data.status !== 'mode_warning') {
                if (data.status === 'disconnected' || data.status === 'stopped') {
                    endReport();
                    latestStats = {};
                }
                streamStatus = 'connecting';
            }
            updateTrayMenu();
        } else if (data.type === 'device_selected') {
            activeStreamDeviceName = data.model || '';
            activeStreamSerial = data.serial || serial;
            updateTrayMenu();
        } else if (data.type === 'stats') {
            latestStats = data;
            if (performanceReport && !performanceReport.endedAt) {
                const first = performanceReport.hostSamples.length === 0;
                addSample(performanceReport.hostSamples, data, MAX_HOST_SAMPLES);
                if (first) sendToWindow('report-available');
            }
            if (Date.now() - lastTrayUpdateTime > 1500) {
                lastTrayUpdateTime = Date.now();
                updateTrayMenu();
            }
        } else if (['host_trace', 'client_trace', 'clock_sync'].includes(data.type)) {
            if (performanceReport?.trace && !performanceReport.endedAt) collectTrace(performanceReport, data);
            return;
        } else if (performanceReport && !performanceReport.endedAt) {
            if (data.type === 'client_info') performanceReport.android = data.metrics;
            if (data.type === 'client_stats') addSample(performanceReport.androidSamples, data.metrics, MAX_CLIENT_SAMPLES);
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
        endReport();
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
app.setName('ReDisplay 1.2');
const profileDirectory = path.join(app.getPath('appData'), 'ReDisplay-v1.2.0-demo');
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

        powerMonitor.on('suspend', () => {
            suspendedStream = hostProcess && activeHostConfig?.autoReconnect !== false
                ? { requestId, config: activeHostConfig } : null;
        });
        powerMonitor.on('resume', async () => {
            const resume = suspendedStream;
            suspendedStream = null;
            if (!resume || resume.requestId !== requestId || quitRequested) return;
            sendToWindow('stream-event', { type: 'state', status: 'connecting', phase: 'resuming', message: t('正在恢复休眠前的串流') });
            const result = await startHostProcess(resume.config, true);
            if (!result.success && !result.cancelled) {
                sendToWindow('stream-status', { status: 'error', message: result.error });
            }
        });

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
        ipcMain.handle('get-device-states', getDeviceStates);
        ipcMain.handle('export-performance-report', exportPerformanceReport);
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
        ipcMain.handle('get-driver-info', getDriverInfo);
        ipcMain.handle('manage-driver', (event, action, serial) => manageDriver(action, serial));
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

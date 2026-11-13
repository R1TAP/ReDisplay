(() => {
    'use strict';

    const api = window.api;
    const { translate } = window.ReDisplayI18n;
    const swatches = [...document.querySelectorAll('[data-palette]')];
    const labels = new Map();
    const optionLabels = new WeakMap();
    const preferences = { language: 'zh-CN', theme: 'system', palette: 'lavender' };
    try {
        const saved = JSON.parse(localStorage.getItem('preferences') || '{}');
        if (['zh-CN', 'en'].includes(saved?.language)) preferences.language = saved.language;
        if (['system', 'light', 'dark'].includes(saved?.theme)) preferences.theme = saved.theme;
        if (swatches.some(button => button.dataset.palette === saved?.palette)) preferences.palette = saved.palette;
    } catch {
        // Use defaults if saved preferences cannot be read.
    }

    const t = (key, values) => translate(preferences.language, key, values);

    function setText(id, value) {
        const element = $(id);
        if (element.textContent !== value) element.textContent = value;
    }

    function showText(id, key, values) {
        labels.set(id, { key, values });
        setText(id, t(key, values));
    }

    function optionWithLabel(label, value) {
        const option = new Option(label(), value);
        optionLabels.set(option, label);
        return option;
    }

    function applyAppearance() {
        document.documentElement.dataset.theme = preferences.theme;
        document.documentElement.dataset.palette = preferences.palette;
        $('select-theme').value = preferences.theme;
        const selected = swatches.find(button => button.dataset.palette === preferences.palette);
        for (const button of swatches) button.setAttribute('aria-pressed', String(button === selected));
        showText('palette-name', selected.dataset.label);
    }

    function applyLanguage() {
        document.documentElement.lang = preferences.language;
        $('select-language').value = preferences.language;
        for (const node of document.querySelectorAll('[data-t]')) node.textContent = t(node.dataset.t);
        for (const node of document.querySelectorAll('[data-label]')) {
            const label = t(node.dataset.label);
            node.setAttribute('aria-label', label);
            if (node.matches('button')) node.title = label;
        }
        for (const [id, label] of labels) $(id).textContent = t(label.key, label.values);
        for (const group of controls.resolution.querySelectorAll('optgroup')) group.label = t(group.dataset.group);
        for (const option of document.querySelectorAll('select option')) {
            const label = optionLabels.get(option);
            if (label) option.textContent = label();
        }
        // The browser clones the selection on change, but leaves the clone stale after an option's text changes.
        for (const select of document.querySelectorAll('select')) {
            select.querySelector('selectedcontent').textContent = select.selectedOptions[0]?.textContent ?? '';
        }
        controls.fps.setAttribute('aria-valuetext', t('每秒 {fps} 帧', { fps: rates[Number(controls.fps.value)] }));
        api.setLanguage(preferences.language);
    }

    function savePreferences() {
        localStorage.setItem('preferences', JSON.stringify(preferences));
    }
    const $ = id => document.getElementById(id);
    const controls = {
        device: $('select-device'),
        display: $('select-display'),
        resolution: $('select-resolution'),
        fps: $('slider-fps'),
        bitrate: $('slider-bitrate'),
        reconnect: $('switch-autoreconnect'),
        trace: $('switch-trace')
    };
    const profiles = window.ReDisplayProfiles;
    const formatters = new Map();
    function number(value, digits = 0) {
        if (!Number.isFinite(value)) return '—';
        const key = preferences.language + digits;
        if (!formatters.has(key)) {
            formatters.set(key, new Intl.NumberFormat(preferences.language, {
                minimumFractionDigits: digits, maximumFractionDigits: digits
            }));
        }
        return formatters.get(key).format(value);
    }
    const units = (value, unit, digits = 0) => Number.isFinite(value) ? number(value, digits) + ' ' + unit : '—';
    const deviceNames = { SM_X810: 'Galaxy Tab S9+', 'SM-X810': 'Galaxy Tab S9+' };
    const commonRates = [30, 60, 90, 120, 144, 165, 180, 240];
    const settings = {
        profile: 'balanced',
        fps: 180,
        bitrate: 60,
        width: 1920,
        height: 1080,
        bufferMode: 'lowlatency'
    };
    const profileButtons = document.querySelectorAll('[data-profile]');
    const bitrateButtons = document.querySelectorAll('[data-val]');
    const bufferButtons = document.querySelectorAll('[data-mode]');
    let preferredFps = settings.fps;
    const standardSizes = [[1920, 1080], [2560, 1440], [1920, 1200], [2560, 1600]]
        .flatMap(([width, height]) => [{ width, height }, { width: height, height: width }]);
    const virtualRates = [60, 90, 120, 144, 180];
    let rates = virtualRates;
    const linkReports = new Map();
    const deviceSpecs = new Map();
    const capabilities = new Map();
    let activeSerial = '';
    let activeMode;
    let recommendation;
    const speedResults = new Map();
    let testingSerial = '';
    const pages = {
        connect: ['连接', '选择接收设备和采集显示器。'],
        picture: ['画面', '选择串流帧率、分辨率和编码设置。'],
        diagnostics: ['诊断', '查看串流实测帧率、耗时和 USB 吞吐。'],
        settings: ['设置', '调整界面外观、语言和连接行为。']
    };
    let devices = [];
    let displays = [];
    let deviceProbe = 0;
    let adbPath;
    let adbBusy = false;
    let deviceLoading = false;
    let driverInfo;
    let driverBusy = false;
    let resolutionChosen = false;
    let serviceActive = false;
    let stopping = false;
    let savedConfig;
    let preview;
    let applying = false;
    let traceActive = false;
    let presentationReceived = false;
    let availableReport = false;
    let exporting = false;
    let liveMbps;

    function showPage(page) {
        const [title, description] = pages[page];
        showText('page-title', title);
        showText('page-description', description);
        for (const button of document.querySelectorAll('[data-page]')) {
            const active = button.dataset.page === page;
            if (active) button.setAttribute('aria-current', 'page');
            else button.removeAttribute('aria-current');
            $(button.getAttribute('aria-controls')).hidden = !active;
        }
        $('page-scroll').scrollTop = 0;
    }

    document.querySelectorAll('[data-page]').forEach(button => {
        button.addEventListener('click', () => showPage(button.dataset.page));
    });

    function appendLog(message, level = 'info') {
        const console = $('log-console');
        const line = document.createElement('div');
        line.className = `log-${level}`;
        line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        console.append(line);
        if (console.childElementCount > 300) console.firstElementChild.remove();
        console.scrollTop = console.scrollHeight;
    }

    function setStatus(state, message, detail = message, values) {
        $('status-pill').className = `status-badge status-${state}`;
        $('status-pill').title = t(detail, values);
        showText('status-text', message, values);
        $('btn-toggle-stream').disabled = stopping || driverBusy;
        $('btn-toggle-stream').classList.toggle('stop', serviceActive);
        showText('text-stream', stopping ? '正在停止…' : serviceActive ? '停止串流' : '启动串流');
        $('icon-stream').firstElementChild.setAttribute('d', serviceActive ? 'M6 6h12v12H6Z' : 'M8 5v14l11-7Z');
    }

    function setHealth(key, state, message, showAction = false, values) {
        $(`dot-${key}`).dataset.state = state;
        showText(`val-${key}`, message, values);
        $(`btn-status-${key}`).hidden = !showAction;
    }

    function deviceLabel(device) {
        return deviceNames[device.model] || device.model || device.product || t('Android 设备');
    }

    async function inspectDevice(serial) {
        const id = ++deviceProbe;
        const isCurrent = () => id === deviceProbe && controls.device.value === serial;
        const device = devices.find(candidate => candidate.serial === serial);
        setHealth('apk', '', serial && !device?.waiting ? '检查中…' : '等待设备');
        renderUsbResult();
        showText('device-hint', device?.waiting ? '设备离线，正在等待重连。' :
            serial ? '已授权 USB 调试。' : '通过 USB 连接并授权调试。');
        renderResolutionChoices(captureSource());
        renderDriverAction();
        renderRecommendation();
        if (!serial || device?.waiting) return;

        const [apk, specs] = await Promise.allSettled([api.checkClientInstalled(serial), api.detectDeviceSpecs(serial)]);
        if (!isCurrent()) return;
        if (apk.status === 'fulfilled' && !apk.value.error) {
            showText('btn-status-apk', apk.value.update ? '更新' : '安装');
            if (apk.value.update) setHealth('apk', 'warning', '版本不匹配', true);
            else if (apk.value.installed) setHealth('apk', 'ready', '已就绪');
            else setHealth('apk', 'warning', '未安装', true);
        } else {
            setHealth('apk', 'warning', '检查失败', true);
        }

        if (specs.status !== 'fulfilled') {
            renderUsbResult();
            return;
        }
        const { width, height, fps, usbTier } = specs.value;
        linkReports.set(serial, usbTier && usbTier !== 'USB 链路未知' ? usbTier : '未知');
        renderUsbResult();
        deviceSpecs.set(serial, specs.value);
        renderDisplay();
        if (width > 0 && height > 0) {
            const model = device?.model?.replaceAll('_', '-');
            const details = { width, height, fps, model };
            if (model) showText('device-hint', fps ? '{model} · {width} × {height} · 最高 {fps} Hz' :
                '{model} · {width} × {height}', details);
            else showText('device-hint', fps ? '设备屏幕 {width} × {height} · 最高 {fps} Hz' : '设备屏幕 {width} × {height}', details);
        }
        renderRecommendation();
    }

    async function loadDevices() {
        if (deviceLoading) return;
        deviceLoading = true;
        const refresh = $('btn-refresh-devices');
        refresh.disabled = true;
        renderAdbStatus();
        showText(refresh.id, '刷新中…');
        try {
            const previous = controls.device.value;
            const priorDevice = devices.find(d => d.serial === previous);
            adbPath = await api.getAdbPath();
            renderAdbStatus();
            devices = adbPath ? await api.getDevices() : [];
            if (serviceActive && priorDevice && !devices.some(d => d.serial === previous)) {
                devices = [...devices, { ...priorDevice, waiting: true }];
            }
            const preferred = devices.find(d => d.serial === previous) || devices.find(d => d.is_tablet) || devices[0];
            controls.device.replaceChildren(controls.device.firstElementChild, ...devices.map(device => {
                const name = deviceLabel(device);
                const duplicate = devices.some(d => d !== device && deviceLabel(d) === name);
                const label = duplicate ? name + ' · ' + device.serial : name;
                return optionWithLabel(() => device.waiting ? t('{name} · 等待重连', { name: label }) : label, device.serial);
            }));
            if (preferred) {
                controls.device.value = preferred.serial;
                appendLog(t('发现 {count} 台 Android 设备。', { count: devices.length }));
            } else {
                controls.device.add(optionWithLabel(() => t('未找到已授权设备'), ''));
                appendLog(t('未找到已授权的 Android 设备。'), 'warn');
            }
            await inspectDevice(controls.device.value);
            if (!preferred && !adbPath) {
                showText('device-hint', '请先在下方设置 ADB，再连接 Android 设备。');
            } else if (!preferred) {
                const result = await api.getDeviceStates();
                const message = result.error ? 'ADB 检查失败 · {error}'
                    : result.states.includes('unauthorized') ? '请在 Android 上允许 USB 调试。'
                    : result.states.includes('offline') ? 'ADB 设备离线，请重新连接 USB。'
                    : '通过 USB 连接并授权调试。';
                showText('device-hint', message, result);
            }
        } catch (error) {
            appendLog(t('设备检查失败 · {error}', { error: error.message }), 'error');
        } finally {
            deviceLoading = false;
            refresh.disabled = false;
            showText(refresh.id, '刷新');
            renderAdbStatus();
        }
    }

    controls.device.addEventListener('change', () => {
        inspectDevice(controls.device.value);
        settingsChanged();
    });
    $('btn-refresh-devices').addEventListener('click', loadDevices);

    function renderAdbStatus() {
        if (adbPath === undefined) showText('val-adb', '检查中…');
        else showText('val-adb', adbPath ? '已就绪' : '未找到 ADB');
        $('dot-adb').dataset.state = adbPath ? 'ready' : adbPath === '' ? 'warning' : '';
        $('val-adb').title = adbPath || '';
        showText('adb-location', adbPath ? '{path}' : '未找到 ADB', { path: adbPath });
        for (const id of ['btn-adb-folder', 'btn-adb-download']) {
            $(id).disabled = adbBusy || deviceLoading || serviceActive || stopping || driverBusy;
        }
    }

    function openAdbSetup() {
        renderAdbStatus();
        if (!$('adb-dialog').open) $('adb-dialog').showModal();
    }

    async function configureAdb(download) {
        if (adbBusy || deviceLoading || serviceActive || stopping || driverBusy) return;
        adbBusy = true;
        $('btn-refresh-devices').disabled = true;
        renderAdbStatus();
        const progress = $('adb-progress');
        progress.classList.remove('warning');
        showText(progress.id, download ? '正在下载并安装 Google Platform-Tools…' : '');
        try {
            const result = await (download ? api.downloadAdb() : api.chooseAdbFolder());
            if (result.canceled) return;
            if (result.error) throw new Error(result.error);
            adbPath = result.path;
            await loadDevices();
            $('adb-dialog').close();
            showText(progress.id, '');
        } catch (error) {
            progress.classList.add('warning');
            showText(progress.id, 'ADB 设置失败 · {error}', { error: error.message });
        } finally {
            adbBusy = false;
            $('btn-refresh-devices').disabled = deviceLoading;
            renderAdbStatus();
        }
    }

    $('btn-status-adb').addEventListener('click', openAdbSetup);
    $('btn-adb-folder').addEventListener('click', () => configureAdb(false));
    $('btn-adb-download').addEventListener('click', () => configureAdb(true));
    $('btn-adb-link').addEventListener('click', async () => {
        try {
            await api.openAdbDownloadPage();
        } catch (error) {
            const progress = $('adb-progress');
            progress.classList.add('warning');
            showText(progress.id, 'ADB 设置失败 · {error}', { error: error.message });
        }
    });

    function renderUsbResult() {
        const serial = controls.device.value;
        const result = speedResults.get(serial);
        const tier = linkReports.get(serial);
        const hasRate = tier && tier !== '未知';
        const busy = testingSerial === serial && Boolean(serial);
        const measured = Number.isFinite(result?.speedMbps);
        const failed = Boolean(result?.error && !busy);
        $('dot-usb').dataset.state = busy || failed ? 'warning' : measured ? 'ready' : '';
        showText('stat-usb-desc', !serial ? '等待设备' : busy ? '测速中…'
            : measured ? '{speed} Mbps' : failed ? '测速失败' : '尚未测速', {
            speed: () => number(result?.speedMbps, 1)
        });
        showText('usb-negotiated', !serial ? '等待设备' : hasRate ? tier : '设备未报告速率');
        $('usb-speed').textContent = number(result?.speedMbps, 1);
        showText('usb-test-time', result?.time ? '{time}' : '尚未测速', {
            time: () => new Date(result.time).toLocaleString(preferences.language, { dateStyle: 'short', timeStyle: 'short' })
        });
        $('usb-stream-rate').textContent = units(serial === activeSerial ? liveMbps : undefined, 'Mbps', 1);
        if (busy) showText('usb-test-state', '正在通过 ADB 传输 10 MiB…');
        else if (result?.error) showText('usb-test-state', 'USB 测速失败 · {error}', result);
        else showText('usb-test-state', measured ? '测速已完成。' : '通过 ADB 传输 10 MiB 数据测量实际吞吐。');
        $('usb-test-state').classList.toggle('warning', failed);
        const selectable = serial && !devices.find(device => device.serial === serial)?.waiting;
        $('btn-open-usb').disabled = !selectable || Boolean(testingSerial);
        $('btn-test-usb').disabled = !selectable || Boolean(testingSerial);
        const action = busy ? '测速中…' : measured ? '重新测速' : '测速';
        showText('btn-open-usb', action);
        showText('btn-test-usb', action === '测速' ? '开始测速' : action);
    }

    async function testUsbSpeed() {
        const serial = controls.device.value;
        if (!serial || testingSerial) return;
        testingSerial = serial;
        renderUsbResult();
        try {
            const result = await api.testUsbSpeed(serial);
            if (!result.success || !Number.isFinite(result.speedMbps)) throw new Error(result.error || t('测速失败'));
            speedResults.set(serial, { ...result, time: Date.now() });
            appendLog(t('ADB 文件传输 {speed} Mbps', { speed: result.speedMbps.toFixed(1) }));
        } catch (error) {
            speedResults.set(serial, { ...speedResults.get(serial), error: error.message });
            appendLog(t('USB 测速失败 · {error}', { error: error.message }), 'error');
        } finally {
            testingSerial = '';
            renderUsbResult();
        }
    }

    $('btn-open-usb').addEventListener('click', testUsbSpeed);
    $('btn-test-usb').addEventListener('click', testUsbSpeed);

    $('btn-status-apk').addEventListener('click', async () => {
        const serial = controls.device.value;
        if (!serial) return;
        const button = $('btn-status-apk');
        button.disabled = true;
        setHealth('apk', 'warning', '正在安装…', true);
        showText(button.id, '正在安装…');
        try {
            const result = await api.installClientApk(serial);
            if (!result.success) throw new Error(result.error);
            if (controls.device.value === serial) setHealth('apk', 'ready', '已就绪');
            appendLog(t('Android 应用已安装。'));
        } catch (error) {
            if (controls.device.value === serial) setHealth('apk', 'warning', '安装失败 · {error}', true, { error: error.message });
            appendLog(t('安装 Android 应用失败 · {error}', { error: error.message }), 'error');
        } finally {
            button.disabled = false;
            showText(button.id, '重试安装');
        }
    });

    function selectedDisplay() {
        return displays.find(display => display.name === controls.display.value);
    }

    function captureSource() {
        if (controls.display.value) return selectedDisplay();

        // Match the Host's automatic display selection without pinning the current topology.
        const { width, height } = settings;
        const landscape = width >= height;
        return displays.find(d => d.isVirtual) ||
            displays.find(d => (d.width === width && d.height === height) || (d.width === height && d.height === width)) ||
            displays.find(d => !d.isPrimary && (d.width >= d.height) === landscape) ||
            (landscape && displays.find(d => d.width >= d.height)) ||
            displays[0];
    }

    function displayLabel(display) {
        const kind = display.isVirtual ? '虚拟显示器' : display.isPrimary ? '主显示器' : '扩展显示器';
        return `${t(kind)} ${display.index + 1}`;
    }

    function renderDisplay() {
        const display = captureSource();
        if (display) showText('val-display', '{label} · {width} × {height} · {fps} Hz', { label: () => displayLabel(display), ...display });
        else showText('val-display', '等待 Windows 显示器。');
        renderResolutionChoices(display);
        renderRefreshRates(display);
        if (!serviceActive) notifyTrayConfig();
    }

    async function loadDisplays() {
        const refresh = $('btn-refresh-displays');
        refresh.disabled = true;
        showText(refresh.id, '刷新中…');
        try {
            const previous = controls.display.value;
            const [list, driver] = await Promise.all([api.getDisplays(), api.getDriverInfo()]);
            displays = list;
            driverInfo = driver;
            controls.display.replaceChildren(
                controls.display.firstElementChild,
                optionWithLabel(() => t('自动选择 · 优先虚拟显示器'), ''),
                ...displays.map(display => optionWithLabel(() => `${displayLabel(display)} · ${display.width} × ${display.height}`, display.name))
            );
            if (displays.some(display => display.name === previous)) controls.display.value = previous;
            renderDisplay();
            renderDriverAction();
            const adapter = displays.find(d => !d.isVirtual && d.adapter?.includes('NVIDIA'))?.adapter;
            $('stat-gpu-desc').textContent = adapter || '—';
            $('stat-gpu-desc').title = adapter || '';
        } catch (error) {
            appendLog(t('显示器检查失败 · {error}', { error: error.message }), 'error');
        } finally {
            refresh.disabled = false;
            showText(refresh.id, '刷新');
        }
    }

    controls.display.addEventListener('change', () => {
        renderDisplay();
        settingsChanged();
    });
    $('btn-refresh-displays').addEventListener('click', loadDisplays);
    $('btn-win-display').addEventListener('click', () => api.openDisplaySettings());
    function renderDriverAction() {
        const button = $('btn-status-driver');
        if (!driverInfo) return;
        const { started, present, version } = driverInfo;
        const serial = controls.device.value;
        const online = serial && devices.some(device => device.serial === serial && !device.waiting);
        setHealth('driver', started ? 'ready' : 'warning',
            started ? version ? '已启用 · {version}' : '已启用' : present ? '驱动存在，未启动' : '未启用',
            !started || Boolean(online) || driverBusy, driverInfo);
        showText(button.id, driverBusy ? '正在配置…' : started ? '适配设备' : '安装');
        button.disabled = driverBusy || serviceActive || stopping;
    }

    $('btn-status-driver').addEventListener('click', async () => {
        if (driverBusy || serviceActive || stopping) return;
        driverBusy = true;
        renderDriverAction();
        $('btn-toggle-stream').disabled = true;
        $('btn-refresh-displays').disabled = true;
        const feedback = $('driver-feedback');
        feedback.hidden = false;
        feedback.classList.remove('warning');
        showText(feedback.id, '正在检测设备并配置虚拟显示模式…');
        const serial = controls.device.value;
        try {
            const result = await api.manageDriver(driverInfo?.started ? 'update' : 'install', serial);
            await loadDisplays();
            if (!result.success) throw new Error(result.error);
            if (result.native && controls.device.value === serial && captureSource()?.isVirtual) {
                setResolution(result.native.width, result.native.height);
                renderDisplay();
                settingsChanged();
            }
            showText(feedback.id, result.native ? '已添加 {width} × {height} 的横竖屏模式。' : '已安装通用虚拟显示模式。', result.native);
        } catch (error) {
            feedback.classList.add('warning');
            showText(feedback.id, '配置显示驱动失败 · {error}', { error: error.message });
            appendLog(t('配置显示驱动失败 · {error}', { error: error.message }), 'error');
        } finally {
            driverBusy = false;
            renderDriverAction();
            $('btn-refresh-displays').disabled = false;
            $('btn-toggle-stream').disabled = stopping;
        }
    });

    function resolutionGroup(width, height, native) {
        const [long, short] = [Math.max(width, height), Math.min(width, height)];
        if (native && long === Math.max(native.width, native.height) && short === Math.min(native.width, native.height)) {
            return '设备原生分辨率';
        }
        if (long * 9 === short * 16) return '16:9';
        if (long * 10 === short * 16) return '16:10';
        return '其他';
    }

    function renderResolutionChoices(display) {
        const native = deviceSpecs.get(controls.device.value);
        const sizes = display?.isVirtual && display.modes?.length ? display.modes : standardSizes;
        const entries = new Map(sizes.map(mode => [mode.width + 'x' + mode.height, mode]));
        const nativeKey = native && native.width + 'x' + native.height;
        const currentKey = settings.width + 'x' + settings.height;
        let selected = currentKey;
        if (!serviceActive && (!resolutionChosen || (display?.isVirtual && !entries.has(currentKey)))) {
            selected = entries.has(nativeKey) ? nativeKey : entries.has(currentKey) ? currentKey : entries.keys().next().value;
            const { width, height } = entries.get(selected);
            settings.width = width;
            settings.height = height;
        }
        if (!entries.has(selected)) entries.set(selected, { width: settings.width, height: settings.height });
        const groups = new Map(['设备原生分辨率', '16:9', '16:10', '其他'].map(key => {
            const group = document.createElement('optgroup');
            group.label = t(key);
            group.dataset.group = key;
            return [key, group];
        }));
        for (const [value, { width, height }] of entries) {
            const group = groups.get(resolutionGroup(width, height, native));
            group.append(optionWithLabel(() => width + ' × ' + height + ' · ' + t(height > width ? '竖屏' : '横屏'), value));
        }
        controls.resolution.replaceChildren(controls.resolution.firstElementChild, ...[...groups.values()].filter(group => group.childElementCount));
        controls.resolution.value = selected;
        showText('val-resolution-ratio', settings.height > settings.width ? '竖屏' : '横屏');
    }

    function setResolution(width, height) {
        resolutionChosen = true;
        settings.width = width;
        settings.height = height;
        renderResolutionChoices(captureSource());
    }

    controls.resolution.addEventListener('change', () => {
        const [width, height] = controls.resolution.value.split('x').map(Number);
        setResolution(width, height);
        renderDisplay();
        settingsChanged();
    });

    function renderRefreshRates(display) {
        const displayRates = display?.modes?.filter(mode => mode.width === settings.width && mode.height === settings.height)
            .map(mode => mode.fps) || [];
        if (display?.isVirtual) {
            rates = [...new Set([...virtualRates, ...displayRates])].sort((a, b) => a - b);
            showText('fps-hint', 'Windows 会选择可用的显示模式。实际发送和面板呈现帧率以硬件为准。');
        } else if (display) {
            const cap = Math.min(240, display.fps);
            rates = commonRates.filter(rate => rate < cap).concat(cap);
            showText('fps-hint', '物理采集显示器当前为 {fps} Hz。', display);
        } else {
            rates = virtualRates;
            showText('fps-hint', '等待显示器。');
        }

        controls.fps.max = rates.length - 1;
        controls.fps.disabled = !display || rates.length < 2 || applying || Boolean(preview) || stopping;
        $('fps-ticks').replaceChildren(...rates.map(rate => {
            const label = document.createElement('span');
            label.textContent = rate;
            return label;
        }));
        setFps(preferredFps);
        renderRecommendation();
    }

    function renderRecommendation() {
        const serial = controls.device.value;
        const specs = deviceSpecs.get(serial);
        const client = capabilities.get(serial);
        const display = captureSource();
        const modes = client?.displayModes;
        const panelRates = Array.isArray(modes) ? modes.filter(mode => mode.width === client.panelWidth &&
            mode.height === client.panelHeight).map(mode => Math.round(mode.hz)) : [];
        const panelFps = Math.max(0, ...panelRates) || specs?.fps || 0;
        const sourceWidth = display && !display.isVirtual ? display.width : settings.width;
        const sourceHeight = display && !display.isVirtual ? display.height : settings.height;
        const matchingCodec = client && client.streamWidth === sourceWidth && client.streamHeight === sourceHeight;
        const codecLimit = matchingCodec ? Math.floor(client.advertisedMaxFps || 0) : 0;
        const panelExceeded = panelFps > 0 && settings.fps > panelFps;
        const codecExceeded = codecLimit > 0 && settings.fps > codecLimit;
        $('device-cap-warning').hidden = !panelExceeded && !codecExceeded;
        if (codecExceeded) showText('device-cap-warning', '目标帧率超过解码器在此分辨率下报告的 {fps} FPS。', { fps: codecLimit });
        else if (panelExceeded) showText('device-cap-warning', '面板最高 {fps} Hz。更高的串流帧率不会提高面板刷新率。', { fps: panelFps });

        const width = specs?.width || client?.panelWidth || 0;
        const height = specs?.height || client?.panelHeight || 0;
        const native = sourceWidth >= sourceHeight
            ? [Math.max(width, height), Math.min(width, height)]
            : [Math.min(width, height), Math.max(width, height)];
        let targetWidth = sourceWidth;
        let targetHeight = sourceHeight;
        if (display?.isVirtual && native[0] && native[1]) {
            const nativePixels = native[0] * native[1];
            const nativeRatio = native[0] / native[1];
            const aspectError = mode => Math.abs(Math.log((mode.width / mode.height) / nativeRatio));
            const best = (display.modes || []).filter(mode =>
                (mode.width >= mode.height) === (native[0] >= native[1]) && mode.width * mode.height <= nativePixels)
                .sort((a, b) => aspectError(a) - aspectError(b) || b.width * b.height - a.width * a.height)[0];
            if (best) {
                targetWidth = best.width;
                targetHeight = best.height;
            }
        }
        const sameSize = targetWidth === sourceWidth && targetHeight === sourceHeight;
        const cap = Math.min(panelFps || Infinity, (sameSize && codecLimit) || Infinity);
        const targetRates = display?.isVirtual ? [...new Set([...virtualRates, ...(display.modes || [])
            .filter(mode => mode.width === targetWidth && mode.height === targetHeight).map(mode => mode.fps)])]
            .sort((a, b) => a - b) : rates;
        const targetFps = Number.isFinite(cap) ? targetRates.findLast(rate => rate <= cap && rate <= settings.fps) : settings.fps;
        recommendation = display && targetFps && (targetWidth !== sourceWidth || targetHeight !== sourceHeight ||
            targetFps !== settings.fps) ? { width: targetWidth, height: targetHeight, fps: targetFps } : null;
        $('device-recommendation').hidden = !recommendation;
        if (recommendation) showText('device-recommendation-text', '设备建议 · {width} × {height} · {fps} FPS', recommendation);
    }

    $('btn-device-recommendation').addEventListener('click', () => {
        if (!recommendation) return;
        applySettings(recommendation);
        settingsChanged();
    });

    function syncSlider(slider) {
        const span = Number(slider.max) - Number(slider.min);
        const fraction = span > 0 ? (Number(slider.value) - Number(slider.min)) / span : 0;
        slider.style.setProperty('--range-progress', fraction * 100 + '%');
    }

    function showFps(fps) {
        syncSlider(controls.fps);
        [...$('fps-ticks').children].forEach((tick, index) =>
            index === Number(controls.fps.value) ? tick.setAttribute('aria-current', 'true') : tick.removeAttribute('aria-current'));
        $('val-fps').textContent = `${fps} FPS`;
        controls.fps.setAttribute('aria-valuetext', t('每秒 {fps} 帧', { fps }));
    }

    function setFps(request) {
        preferredFps = request;
        const index = rates.findLastIndex(rate => rate <= request);
        controls.fps.value = Math.max(0, index);
        settings.fps = rates[Number(controls.fps.value)];
        showFps(settings.fps);
    }

    controls.fps.addEventListener('input', () => showFps(rates[Number(controls.fps.value)]));
    controls.fps.addEventListener('change', () => {
        const fps = rates[Number(controls.fps.value)];
        if (settings.fps === fps) return;
        setFps(fps);
        renderRecommendation();
        settingsChanged();
    });

    function selectButtons(buttons, key, value) {
        buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset[key] === String(value))));
    }

    function setBitrate(value) {
        controls.bitrate.value = value;
        syncSlider(controls.bitrate);
        $('val-bitrate').textContent = `${value} Mbps`;
        controls.bitrate.setAttribute('aria-valuetext', `${value} Mbps`);
        selectButtons(bitrateButtons, 'val', value);
    }

    function setBufferMode(mode) {
        settings.bufferMode = mode;
        selectButtons(bufferButtons, 'mode', mode);
    }

    function applySettings(config) {
        if (config.serial !== undefined) controls.device.value = config.serial;
        if (config.displayName !== undefined) controls.display.value = config.displayName || '';
        if (config.autoReconnect !== undefined) controls.reconnect.checked = config.autoReconnect;
        if (config.trace !== undefined) controls.trace.checked = config.trace;
        if (config.width && config.height) setResolution(config.width, config.height);
        settings.profile = config.profile || settings.profile;
        settings.bitrate = config.bitrate ?? settings.bitrate;
        preferredFps = config.fps ?? preferredFps;
        setBitrate(settings.bitrate);
        setBufferMode(config.bufferMode || settings.bufferMode);
        selectButtons(profileButtons, 'profile', settings.profile);
        showText('profile-hint', profiles[settings.profile].description);
        renderDisplay();
    }

    profileButtons.forEach(button => button.addEventListener('click', () => {
        const profile = button.dataset.profile;
        applySettings({ profile });
        settingsChanged();
    }));

    function changeBitrate(value) {
        settings.bitrate = value;
        setBitrate(value);
        settingsChanged();
    }
    controls.bitrate.addEventListener('input', () => setBitrate(Number(controls.bitrate.value)));
    controls.bitrate.addEventListener('change', () => changeBitrate(Number(controls.bitrate.value)));
    bitrateButtons.forEach(button => button.addEventListener('click', () => changeBitrate(Number(button.dataset.val))));
    bufferButtons.forEach(button => button.addEventListener('click', () => {
        setBufferMode(button.dataset.mode);
        settingsChanged();
    }));
    controls.reconnect.addEventListener('change', settingsChanged);
    controls.trace.addEventListener('change', settingsChanged);

    function streamConfig() {
        const display = selectedDisplay();
        return {
            ...settings,
            serial: controls.device.value,
            display: display?.index ?? null,
            displayName: controls.display.value,
            orientation: settings.height > settings.width ? 'portrait' : 'landscape',
            autoReconnect: controls.reconnect.checked,
            trace: controls.trace.checked
        };
    }

    function notifyTrayConfig() {
        const resolutions = [...controls.resolution.options].map(option => option.value.split('x').map(Number));
        api.notifyConfigChanged({ ...streamConfig(), resolutions });
    }

    function showFeedback(message, values, kind = '') {
        $('stream-feedback').hidden = !message;
        $('stream-feedback').className = 'stream-feedback ' + kind;
        showText('stream-feedback', message, values);
    }

    function renderPendingSettings() {
        const draft = streamConfig();
        const pending = serviceActive && !stopping && !applying && !preview && savedConfig &&
            Object.keys(draft).some(key => key !== 'display' && draft[key] !== savedConfig[key]);
        $('draft-banner').hidden = !pending;
        for (const control of document.querySelectorAll('[data-stream-setting]')) {
            control.disabled = applying || Boolean(preview) || stopping ||
                (control === controls.fps && (!captureSource() || rates.length < 2));
        }
        renderPresentation();
        renderDriverAction();
        renderAdbStatus();
    }

    function settingsChanged() {
        showFeedback('');
        if (!serviceActive) notifyTrayConfig();
        renderPendingSettings();
    }

    function renderPresentation() {
        const enabled = controls.trace.checked;
        $('btn-enable-trace').hidden = enabled || traceActive;
        $('btn-enable-trace').disabled = applying || Boolean(preview) || stopping;
        $('presentation-data').hidden = !traceActive || !presentationReceived;
        $('presentation-status').hidden = traceActive && presentationReceived;
        const message = traceActive ? '正在等待图层和链路样本。'
            : enabled ? '追踪将在下一次串流连接时开始。'
            : '开启追踪后可查看图层呈现与链路延迟。';
        showText('presentation-status', message);
    }

    $('btn-enable-trace').addEventListener('click', () => {
        controls.trace.checked = true;
        settingsChanged();
    });

    function renderActiveMode() {
        $('picture-active-mode').hidden = !activeMode;
        if (activeMode) showText('picture-active-mode',
            '生效中 · {width} × {height} · 目标 {fps} FPS / {bitrate} Mbps · Windows {displayHz} Hz', activeMode);
    }

    function resetSession() {
        activeMode = undefined;
        traceActive = false;
        presentationReceived = false;
        resetStats();
        renderActiveMode();
        renderPresentation();
    }

    async function restartForPreview() {
        if (applying || preview || stopping || !serviceActive) return;
        const next = { config: streamConfig() };
        preview = next;
        applying = true;
        resetSession();
        showFeedback('正在重新连接以应用更改…');
        setStatus('connecting', '正在应用设置');
        renderPendingSettings();
        next.watchdog = setTimeout(() => {
            appendLog(t('新设置未能建立串流，正在还原。'), 'warn');
            revertPreview(t('新设置未能建立串流，正在还原。'));
        }, 15000);
        try {
            const result = await api.restartStream(next.config);
            if (!result.success && !result.cancelled) throw new Error(result.error);
        } catch (error) {
            if (preview !== next) return;
            appendLog(t('应用设置失败 · {error}', { error: error.message }), 'error');
            await revertPreview(error.message);
        }
    }

    function showPreview(data) {
        if (!preview || preview.timer) return;
        clearTimeout(preview.watchdog);
        applying = false;
        showFeedback('');
        showText('reconfig-desc', '当前串流 {width} × {height} · 目标 {fps} FPS / {bitrate} Mbps。', data);
        $('reconfig-confirm-banner').hidden = false;
        showText('reconfig-countdown', '还原 {seconds} 秒', { seconds: 10 });
        let remaining = 10;
        preview.interval = setInterval(() => showText('reconfig-countdown', '还原 {seconds} 秒', { seconds: --remaining }), 1000);
        preview.timer = setTimeout(() => revertPreview(), 10000);
        renderPendingSettings();
    }

    function clearPreview() {
        clearTimeout(preview?.watchdog);
        clearTimeout(preview?.timer);
        clearInterval(preview?.interval);
        preview = null;
        $('reconfig-confirm-banner').hidden = true;
    }

    function restoreControls() {
        const previousSerial = controls.device.value;
        applySettings(savedConfig);
        if (controls.device.value !== previousSerial) inspectDevice(controls.device.value);
    }

    async function revertPreview(reason) {
        clearPreview();
        if (!serviceActive || !savedConfig || stopping) return;
        applying = true;
        restoreControls();
        resetSession();
        showFeedback(reason ? '应用设置失败，正在还原 · {error}' : '正在还原上一组设置…',
            { error: reason }, reason ? 'warning' : '');
        setStatus('connecting', '正在还原设置');
        renderPendingSettings();
        try {
            const result = await api.restartStream(savedConfig);
            if (!result.success && !result.cancelled) throw new Error(result.error);
        } catch (error) {
            if (stopping) return;
            applying = false;
            serviceActive = false;
            setStatus('error', '还原失败', error.message);
            showFeedback('还原失败 · {error}', { error: error.message }, 'error');
            appendLog(t('还原失败 · {error}', { error: error.message }), 'error');
            renderPendingSettings();
        }
    }

    $('btn-apply-settings').addEventListener('click', restartForPreview);
    $('btn-discard-settings').addEventListener('click', () => {
        restoreControls();
        settingsChanged();
    });
    $('btn-reconfig-keep').addEventListener('click', () => {
        if (!preview) return;
        savedConfig = preview.config;
        clearPreview();
        renderPendingSettings();
        appendLog(t('已保留新设置。'));
    });
    $('btn-reconfig-revert').addEventListener('click', () => revertPreview());

    async function startStream() {
        if (serviceActive || stopping || driverBusy || adbBusy) return;
        if (adbPath === '') {
            showPage('connect');
            openAdbSetup();
            return;
        }
        savedConfig = streamConfig();
        serviceActive = true;
        applying = true;
        showFeedback('');
        setStatus('connecting', '正在连接');
        renderPendingSettings();
        try {
            const result = await api.startStream(savedConfig);
            if (!result.success && !result.cancelled) throw new Error(result.error);
        } catch (error) {
            if (stopping) return;
            serviceActive = false;
            applying = false;
            setStatus('error', '启动失败', error.message);
            showFeedback('启动失败 · {error}', { error: error.message }, 'error');
            renderPendingSettings();
            appendLog(t('启动失败 · {error}', { error: error.message }), 'error');
            showPage('diagnostics');
            $('log-drawer').open = true;
        }
    }

    async function stopStream() {
        if (stopping) return;
        stopping = true;
        clearPreview();
        showFeedback('');
        setStatus('stopping', '正在停止');
        renderPendingSettings();
        try {
            await api.stopStream();
        } catch (error) {
            stopping = false;
            applying = false;
            setStatus('error', '停止失败', error.message);
            showFeedback('停止失败 · {error}', { error: error.message }, 'error');
            renderPendingSettings();
        }
    }

    $('btn-toggle-stream').addEventListener('click', () => serviceActive ? stopStream() : startStream());

    function updateStats(data) {
        liveMbps = data.mbps;
        setText('stat-fps', number(data.fps, 1));
        showText('stat-fps-desc', '采集 {capture} · 编码 {encode}', {
            capture: number(data.wgcFps, 1), encode: number(data.encodeFps, 1)
        });
        setText('stat-bitrate', number(data.mbps, 1));
        setText('stat-latency', data.encodeSamples ? number(data.encodeMs, 2) : '—');
        setText('stat-encode-tail', data.encodeSamples ? 'P95 ' + units(data.encodeP95Ms, 'ms', 2) : 'P95 —');
        setText('stat-frame-gap', data.encodeSamples && data.encodeGapP95Ms > 0
            ? units(data.encodeGapP95Ms, 'ms', 2) : '—');
        setText('stat-frames', number(data.frames));
        showText('stat-send-queue', data.queueDepth === 1 ? '1 帧' : '{count} 帧', { count: number(data.queueDepth) });
        showText('stat-queue-peak', data.queuePeak === 1 ? '1 帧' : '{count} 帧', { count: number(data.queuePeak) });
        setText('stat-host-cpu', data.hostCpuPercent > 0 && data.hostCpuPercent < .1
            ? '<0.1%' : Number.isFinite(data.hostCpuPercent) ? number(data.hostCpuPercent, 1) + '%' : '—');
        const total = data.frames + data.dropped;
        const dropped = total ? number(data.dropped * 100 / total, 1) : '—';
        showText('badge-drop-rate', total ? '队列丢弃 {dropped}%' : '队列丢弃 —', { dropped });
        $('badge-drop-rate').classList.toggle('warning', data.dropped > 0);
        setText('usb-stream-rate', units(controls.device.value === activeSerial ? liveMbps : undefined, 'Mbps', 1));
    }

    function updateClientStats(data) {
        setText('stat-client-rx', number(data.receivedFps, 1));
        setText('stat-client-decode', number(data.decodedFps, 1));
        setText('stat-client-surface', number(data.surfaceFps, 1));
        showText('stat-client-rx-note', '完整视频帧');
        setText('stat-client-decode-time', data.decode?.samples ? 'P95 ' + units(data.decode.p95Ms, 'ms', 2) : 'P95 —');
        if (data.surfaceGap?.samples) {
            showText('stat-client-surface-gap', '间隔 P95 {ms} ms', { ms: number(data.surfaceGap.p95Ms, 2) });
        } else showText('stat-client-surface-gap', '—');
        setText('stat-client-panel', units(data.displayHz > 0 ? data.displayHz : undefined, 'Hz',
            Math.abs(data.displayHz - Math.round(data.displayHz)) < .01 ? 0 : 2));
        setText('stat-client-drops', number(data.inputDrops));
        setText('stat-client-pending', number(data.pendingFrames));
    }

    function renderReport(message, values, state = '') {
        $('btn-export-report').disabled = !availableReport || exporting;
        showText('btn-export-report', exporting ? '正在导出…' : '导出性能报告');
        $('report-status').className = 'field-hint ' + state;
        showText('report-status', message ?? (availableReport ? '' : '采集到串流数据后可导出。'), values);
    }

    $('btn-export-report').addEventListener('click', async () => {
        if (!availableReport || exporting) return;
        exporting = true;
        renderReport('');
        let message, detail, state;
        try {
            const result = await api.exportPerformanceReport();
            if (result.success) {
                message = '性能报告已保存。';
                state = 'success';
            } else if (!result.canceled) {
                message = '导出失败 · {error}';
                detail = { error: result.error };
                state = 'error';
            }
        } catch (error) {
            message = '导出失败 · {error}';
            detail = { error: error.message };
            state = 'error';
        } finally {
            exporting = false;
            renderReport(message, detail, state);
        }
    });
    api.onReportAvailable(() => {
        availableReport = true;
        if (!exporting) renderReport();
    });

    function resetStats() {
        liveMbps = undefined;
        for (const id of ['stat-fps', 'stat-bitrate', 'stat-latency', 'stat-frames',
            'stat-client-rx', 'stat-client-decode', 'stat-client-surface', 'stat-client-decode-time', 'usb-stream-rate',
            'stat-client-panel', 'stat-client-drops', 'stat-client-pending', 'stat-client-info',
            'stat-send-queue', 'stat-queue-peak', 'stat-layer-present', 'stat-layer-gap', 'stat-trace-latency',
            'stat-trace-clock', 'stat-host-cpu', 'stat-host-gpu', 'stat-frame-gap', 'stream-mode', 'card-fps-target']) {
            labels.delete(id);
            $(id).textContent = '—';
            $(id).removeAttribute('title');
        }
        for (const id of ['stat-client-surface-gap', 'badge-drop-rate', 'stat-fps-desc', 'stat-client-rx-note']) {
            showText(id, '—');
        }
        $('stat-encode-tail').textContent = 'P95 —';
        $('badge-drop-rate').classList.remove('warning');
    }

    const connectingLabels = {
        connecting: '正在建立连接',
        detecting_devices: '正在检查设备',
        launching_app: '正在启动 Android 应用',
        waiting_device: '等待设备连接',
        disconnected: '正在重连'
    };

    api.onStreamEvent(data => {
        if (data.type === 'stats') {
            updateStats(data);
        } else if (data.type === 'client_info') {
            const info = data.metrics;
            if (activeSerial && activeMode) {
                capabilities.set(activeSerial, { ...info, streamWidth: activeMode.width, streamHeight: activeMode.height });
                renderRecommendation();
            }
            if (info.decoder) {
                $('stat-client-info').textContent = info.decoder;
                $('stat-client-info').title = info.decoder;
            }
        } else if (data.type === 'client_stats') {
            updateClientStats(data.metrics);
        } else if (data.type === 'presentation') {
            const { fps, interval } = data.metrics;
            $('stat-layer-present').textContent = units(fps, 'FPS', 1);
            $('stat-layer-gap').textContent = units(interval?.p95Ms, 'ms', 2);
            if (Number.isFinite(fps)) presentationReceived = true;
            renderPresentation();
        } else if (data.type === 'gpu_stats') {
            if (data.adapters.length === 1) {
                const { gpuPercent, encoderPercent } = data.adapters[0];
                $('stat-host-gpu').textContent = Number.isFinite(gpuPercent) && Number.isFinite(encoderPercent)
                    ? number(gpuPercent) + '% / ' + number(encoderPercent) + '%' : '—';
            }
        } else if (data.type === 'trace_summary') {
            const { captureToSurface, clockHalfRtt } = data.metrics;
            $('stat-trace-latency').textContent = units(captureToSurface?.p95Ms, 'ms', 2);
            $('stat-trace-clock').textContent = units(clockHalfRtt?.p95Ms, 'ms', 2);
            if (captureToSurface) presentationReceived = true;
            renderPresentation();
        } else if (data.type === 'device_selected') {
            activeSerial = data.serial;
            appendLog(t('已选择设备 · {name}', { name: data.model || data.serial }));
        } else if (data.type === 'state') {
            if (data.status === 'streaming') {
                serviceActive = true;
                resetStats();
                activeMode = data;
                traceActive = data.trace === true;
                presentationReceived = false;
                applying = false;
                renderActiveMode();
                renderPendingSettings();
                const source = displays.find(display => display.index === data.display);
                if (source) {
                    showText('val-display', '{label} · {width} × {height} · Windows {displayHz} Hz', { ...data, label: () => displayLabel(source) });
                }
                $('stream-mode').textContent = data.width + ' × ' + data.height + ' · ' + units(data.displayHz, 'Hz');
                $('card-fps-target').textContent = units(data.fps, 'FPS');
                showFeedback('');
                setStatus('streaming', '串流中 · 目标 {fps} FPS', undefined, data);
                showPreview(data);
                appendLog(t('串流已建立 · {mode}', { mode: data.width + ' × ' + data.height + ' / ' + data.fps + ' FPS' }));
            } else if (connectingLabels[data.status]) {
                if (data.status === 'disconnected') resetSession();
                if (data.phase === 'resuming') serviceActive = true;
                const phase = { installing: '正在安装 Android 应用', resuming: '正在恢复休眠前的串流' };
                const message = phase[data.phase] || connectingLabels[data.status];
                if (!stopping) {
                    const reconnecting = data.status === 'disconnected' || data.status === 'waiting_device' && Boolean(activeSerial);
                    setStatus(reconnecting ? 'reconnecting' : 'connecting', message, data.message || message);
                }
                appendLog(data.message || t(message));
            } else if (data.status === 'mode_warning' || data.status === 'error') {
                appendLog(data.message, data.status === 'error' ? 'error' : 'warn');
                if (data.status === 'error' && !stopping) {
                    setStatus('error', '连接遇到问题', data.message);
                    showFeedback('连接遇到问题 · {error}', { error: data.message }, 'error');
                } else if (!stopping) {
                    showFeedback('显示模式提示 · {message}', { message: data.message }, 'warning');
                }
            }
        }
    });

    api.onStreamStatus(status => {
        if (preview && !stopping) {
            revertPreview(status.message);
            return;
        }
        serviceActive = false;
        stopping = false;
        applying = false;
        activeSerial = '';
        clearPreview();
        resetSession();
        renderPendingSettings();
        if (status.status === 'error') {
            setStatus('error', '串流异常退出', status.message);
            showFeedback(status.message ? '串流异常退出 · {error}' : '串流异常退出。', { error: status.message }, 'error');
            appendLog(status.message || t('串流异常退出。'), 'error');
            showPage('diagnostics');
            $('log-drawer').open = true;
        } else {
            showFeedback('');
            setStatus('idle', '待机就绪');
            notifyTrayConfig();
            loadDisplays();
            appendLog(t('串流已停止。'));
        }
    });

    api.onClientInstalled(serial => {
        if (serial === controls.device.value) setHealth('apk', 'ready', '已就绪');
    });
    api.onTrayAction(data => {
        if (data?.action === 'start') startStream();
        else if (data?.action === 'change-config' && !applying && !preview && !stopping) {
            applySettings(data.config);
            settingsChanged();
            if (serviceActive) showPage('picture');
        }
    });

    $('btn-tray-min').addEventListener('click', () => api.hideToTray());
    $('btn-minimize').addEventListener('click', () => api.minimizeWindow());
    $('btn-maximize').addEventListener('click', () => api.maximizeWindow());
    $('btn-close').addEventListener('click', () => api.closeWindow());
    $('btn-clear-log').addEventListener('click', () => $('log-console').replaceChildren());

    $('select-theme').addEventListener('change', event => {
        preferences.theme = event.target.value;
        applyAppearance();
        savePreferences();
    });
    $('select-language').addEventListener('change', event => {
        preferences.language = event.target.value;
        applyLanguage();
        savePreferences();
    });
    for (const button of swatches) {
        button.addEventListener('click', () => {
            preferences.palette = button.dataset.palette;
            applyAppearance();
            savePreferences();
        });
    }

    applyAppearance();
    setBitrate(settings.bitrate);
    showText('profile-hint', profiles[settings.profile].description);
    applyLanguage();
    showPage('connect');
    setStatus('idle', '待机就绪');
    setHealth('apk', '', '等待设备');
    renderUsbResult();
    resetStats();
    renderReport();
    renderPendingSettings();
    appendLog(t('控制中心已就绪。'));
    renderDisplay();
    loadDevices();
    loadDisplays();
})();

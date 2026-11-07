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

    function showText(id, key, values) {
        labels.set(id, { key, values });
        document.getElementById(id).textContent = t(key, values);
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
        for (const option of document.querySelectorAll('select option')) {
            const label = optionLabels.get(option);
            if (label) option.textContent = label();
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
        reconnect: $('switch-autoreconnect')
    };
    const profiles = {
        esports: { fps: 180, bitrate: 60, bufferMode: 'lowlatency' },
        quality: { fps: 120, bitrate: 85, bufferMode: 'lowlatency' },
        office: { fps: 60, bitrate: 30, bufferMode: 'smooth' }
    };
    const commonRates = [30, 60, 90, 120, 144, 165, 180, 240];
    const settings = {
        profile: 'esports',
        fps: 180,
        bitrate: 60,
        width: 1752,
        height: 2800,
        bufferMode: 'lowlatency'
    };
    const profileButtons = document.querySelectorAll('[data-profile]');
    const bitrateButtons = document.querySelectorAll('[data-val]');
    const bufferButtons = document.querySelectorAll('[data-mode]');
    let preferredFps = settings.fps;
    const virtualRates = [60, 90, 120, 144, 180];
    let rates = virtualRates;
    const linkReports = new Map();
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
    let manualSettings = false;
    let serviceActive = false;
    let stopping = false;
    let savedConfig;
    let preview;
    let restartDebounce;

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
        document.querySelector('main').scrollTop = 0;
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
        $('btn-toggle-stream').disabled = stopping;
        $('btn-toggle-stream').classList.toggle('stop', serviceActive);
        showText('text-stream', stopping ? '正在停止…' : serviceActive ? '停止串流' : '启动串流');
        $('icon-stream').firstElementChild.setAttribute('d', serviceActive ? 'M6 6h12v12H6Z' : 'M8 5v14l11-7Z');
    }

    function setHealth(key, state, message, showAction = false) {
        $(`dot-${key}`).dataset.state = state;
        showText(`val-${key}`, message);
        $(`btn-status-${key}`).hidden = !showAction;
    }

    function deviceLabel(device) {
        return device.model || device.product || t('Android 设备');
    }

    async function inspectDevice(serial) {
        const id = ++deviceProbe;
        const isCurrent = () => id === deviceProbe && controls.device.value === serial;
        setHealth('apk', '', serial ? '检查中…' : '等待设备');
        renderUsbResult();
        showText('device-hint', serial ? '已授权 USB 调试。' : '通过 USB 连接并授权调试。');
        if (!serial) return;

        const [apk, specs] = await Promise.allSettled([api.checkClientInstalled(serial), api.detectDeviceSpecs(serial)]);
        if (!isCurrent()) return;
        if (apk.status === 'fulfilled' && !apk.value.error) {
            if (apk.value.installed) setHealth('apk', 'ready', '已就绪');
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
        if (width > 0 && height > 0) {
            showText('device-hint', '设备屏幕 {width} × {height} · 最高 {fps} Hz', { width, height, fps });
            if (!serviceActive && !manualSettings) {
                setResolution(width, height);
                renderDisplay();
                api.notifyConfigChanged(streamConfig());
            }
        }
    }

    async function loadDevices() {
        const refresh = $('btn-refresh-devices');
        refresh.disabled = true;
        try {
            const previous = controls.device.value;
            devices = await api.getDevices();
            const preferred = devices.find(d => d.serial === previous) || devices.find(d => d.is_tablet) || devices[0];
            controls.device.replaceChildren(...devices.map(device => {
                const name = deviceLabel(device);
                const duplicate = devices.some(d => d !== device && deviceLabel(d) === name);
                return new Option(duplicate ? `${name} · ${device.serial}` : name, device.serial);
            }));
            if (preferred) {
                controls.device.value = preferred.serial;
                appendLog(t('发现 {count} 台 Android 设备。', { count: devices.length }));
            } else {
                controls.device.add(optionWithLabel(() => t('未找到已授权设备'), ''));
                appendLog(t('未找到已授权的 Android 设备。'), 'warn');
            }
            await inspectDevice(controls.device.value);
        } catch (error) {
            appendLog(t('设备检查失败 · {error}', { error: error.message }), 'error');
        } finally {
            refresh.disabled = false;
        }
    }

    controls.device.addEventListener('change', () => {
        inspectDevice(controls.device.value);
        settingsChanged();
    });
    $('btn-refresh-devices').addEventListener('click', loadDevices);

    function renderUsbResult() {
        const serial = controls.device.value;
        const result = speedResults.get(serial);
        const tier = linkReports.get(serial) || '未知';
        const busy = testingSerial === serial && Boolean(serial);
        showText('stat-usb-desc', !serial ? '等待设备' : tier);
        showText('usb-negotiated', '设备报告 · {tier}', { tier: () => t(tier) });
        $('usb-speed').textContent = result?.speedMBps.toFixed(1) ?? '—';
        $('usb-estimate').hidden = !result;
        if (result) showText('usb-estimate', '{tier} · 吞吐估算', { tier: () => t(result.estimatedTier) });
        showText('usb-test-state', busy ? '正在传输…' : result ? '' : '尚未测速');
        $('btn-open-usb').disabled = !serial || Boolean(testingSerial);
        $('btn-test-usb').disabled = !serial || Boolean(testingSerial);
        showText('btn-test-usb', busy ? '测速中…' : result ? '重新测速' : '开始测速');
    }

    async function testUsbSpeed() {
        const serial = controls.device.value;
        if (!serial || testingSerial) return;
        testingSerial = serial;
        renderUsbResult();
        let failed = false;
        try {
            const result = await api.testUsbSpeed(serial);
            if (!result.success) throw new Error(result.error);
            speedResults.set(serial, result);
            appendLog(t('ADB 文件传输 {speed} MB/s', { speed: result.speedMBps.toFixed(1) }));
        } catch (error) {
            failed = true;
            appendLog(t('USB 测速失败 · {error}', { error: error.message }), 'error');
        } finally {
            testingSerial = '';
            renderUsbResult();
            if (failed && controls.device.value === serial) showText('usb-test-state', '测速失败，请重试');
        }
    }

    $('btn-open-usb').addEventListener('click', () => {
        showPage('diagnostics');
        testUsbSpeed();
    });
    $('btn-test-usb').addEventListener('click', testUsbSpeed);

    $('btn-status-apk').addEventListener('click', async () => {
        const serial = controls.device.value;
        if (!serial) return;
        const button = $('btn-status-apk');
        button.disabled = true;
        setHealth('apk', 'warning', '正在安装…');
        try {
            const result = await api.installClientApk(serial);
            if (!result.success) throw new Error(result.error);
            if (controls.device.value === serial) setHealth('apk', 'ready', '已就绪');
            appendLog(t('Android 应用已安装。'));
        } catch (error) {
            if (controls.device.value === serial) setHealth('apk', 'warning', '安装失败', true);
            appendLog(t('安装 Android 应用失败 · {error}', { error: error.message }), 'error');
        } finally {
            button.disabled = false;
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
        renderRefreshRates(display);
    }

    async function loadDisplays() {
        const refresh = $('btn-refresh-displays');
        refresh.disabled = true;
        try {
            const previous = controls.display.value;
            const [list, driverReady] = await Promise.all([api.getDisplays(), api.checkDriverStatus()]);
            displays = list;
            controls.display.replaceChildren(
                optionWithLabel(() => t('自动选择 · 优先虚拟显示器'), ''),
                ...displays.map(display => optionWithLabel(() => `${displayLabel(display)} · ${display.width} × ${display.height}`, display.name))
            );
            if (displays.some(display => display.name === previous)) controls.display.value = previous;
            renderDisplay();
            if (driverReady) setHealth('driver', 'ready', '已启用');
            else setHealth('driver', 'warning', '未启用', true);
            $('stat-gpu-desc').textContent = displays.find(d => !d.isVirtual && d.adapter?.includes('NVIDIA'))?.adapter || 'NVENC H.264';
        } catch (error) {
            appendLog(t('显示器检查失败 · {error}', { error: error.message }), 'error');
        } finally {
            refresh.disabled = false;
        }
    }

    controls.display.addEventListener('change', () => {
        renderDisplay();
        settingsChanged();
    });
    $('btn-refresh-displays').addEventListener('click', loadDisplays);
    $('btn-win-display').addEventListener('click', () => api.openDisplaySettings());
    $('btn-status-driver').addEventListener('click', async () => {
        const button = $('btn-status-driver');
        button.disabled = true;
        setHealth('driver', 'warning', '正在安装…');
        try {
            const result = await api.manageDriver('install');
            if (!result.success) throw new Error(result.error);
            appendLog(t('显示驱动已安装，正在刷新显示器。'));
            await loadDisplays();
        } catch (error) {
            setHealth('driver', 'warning', '安装失败', true);
            appendLog(t('安装显示驱动失败 · {error}', { error: error.message }), 'error');
        } finally {
            button.disabled = false;
        }
    });

    function setResolution(width, height) {
        settings.width = width;
        settings.height = height;
        const value = `${width}x${height}`;
        if (![...controls.resolution.options].some(option => option.value === value)) {
            controls.resolution.add(optionWithLabel(() => t('{width} × {height} · 设备规格', { width, height }), value), 0);
        }
        controls.resolution.value = value;
        showText('val-resolution-ratio', height > width ? '竖屏' : '横屏');
    }

    controls.resolution.addEventListener('change', () => {
        const [width, height] = controls.resolution.value.split('x').map(Number);
        manualSettings = true;
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
        controls.fps.disabled = !display || rates.length < 2;
        const labels = rates.length <= 6 ? rates : [rates[0], rates.at(-1)];
        $('fps-ticks').replaceChildren(...labels.map(rate => {
            const label = document.createElement('span');
            label.textContent = rate;
            return label;
        }));
        setFps(preferredFps);
    }

    function showFps(fps) {
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
        selectCustomProfile();
        settingsChanged();
    });

    function selectButtons(buttons, key, value) {
        buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset[key] === String(value))));
    }

    function selectCustomProfile() {
        manualSettings = true;
        settings.profile = 'custom';
        selectButtons(profileButtons, 'profile', settings.profile);
    }

    function setBitrate(value) {
        controls.bitrate.value = value;
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
        if (config.width && config.height) setResolution(config.width, config.height);
        settings.profile = config.profile || settings.profile;
        settings.bitrate = config.bitrate ?? settings.bitrate;
        preferredFps = config.fps ?? preferredFps;
        setBitrate(settings.bitrate);
        setBufferMode(config.bufferMode || settings.bufferMode);
        selectButtons(profileButtons, 'profile', settings.profile);
        renderDisplay();
    }

    profileButtons.forEach(button => button.addEventListener('click', () => {
        manualSettings = true;
        const profile = button.dataset.profile;
        applySettings({ profile, ...profiles[profile] });
        settingsChanged();
    }));

    function changeBitrate(value) {
        settings.bitrate = value;
        setBitrate(value);
        selectCustomProfile();
        settingsChanged();
    }
    controls.bitrate.addEventListener('input', () => setBitrate(Number(controls.bitrate.value)));
    controls.bitrate.addEventListener('change', () => changeBitrate(Number(controls.bitrate.value)));
    bitrateButtons.forEach(button => button.addEventListener('click', () => changeBitrate(Number(button.dataset.val))));
    bufferButtons.forEach(button => button.addEventListener('click', () => {
        setBufferMode(button.dataset.mode);
        selectCustomProfile();
        settingsChanged();
    }));
    controls.reconnect.addEventListener('change', settingsChanged);

    function streamConfig() {
        const display = selectedDisplay();
        return {
            ...settings,
            serial: controls.device.value,
            display: display?.index ?? null,
            displayName: controls.display.value,
            orientation: settings.height > settings.width ? 'portrait' : 'landscape',
            autoReconnect: controls.reconnect.checked
        };
    }

    function settingsChanged() {
        api.notifyConfigChanged(streamConfig());
        if (!serviceActive || stopping) return;
        clearTimeout(restartDebounce);
        restartDebounce = setTimeout(restartForPreview, 150);
    }

    async function restartForPreview() {
        clearPreview();
        const next = { config: streamConfig() };
        preview = next;
        setStatus('connecting', '正在应用设置');
        next.watchdog = setTimeout(() => {
            appendLog(t('新设置未能建立串流，正在还原。'), 'warn');
            revertPreview();
        }, 15000);
        try {
            const result = await api.restartStream(next.config);
            if (!result.success && !result.cancelled) throw new Error(result.error);
        } catch (error) {
            if (preview !== next) return;
            appendLog(t('应用设置失败 · {error}', { error: error.message }), 'error');
            revertPreview();
        }
    }

    function showPreview(data) {
        if (!preview || preview.timer) return;
        clearTimeout(preview.watchdog);
        showText('reconfig-desc', '当前串流 {width} × {height} · {fps} FPS。超时将恢复上一组设置。', data);
        $('reconfig-confirm-banner').hidden = false;
        showText('reconfig-countdown', '还原 {seconds} 秒', { seconds: 10 });
        let remaining = 10;
        preview.interval = setInterval(() => showText('reconfig-countdown', '还原 {seconds} 秒', { seconds: --remaining }), 1000);
        preview.timer = setTimeout(revertPreview, 10000);
    }

    function clearPreview() {
        clearTimeout(preview?.watchdog);
        clearTimeout(preview?.timer);
        clearInterval(preview?.interval);
        preview = null;
        $('reconfig-confirm-banner').hidden = true;
    }

    async function revertPreview() {
        clearTimeout(restartDebounce);
        clearPreview();
        if (!serviceActive || !savedConfig) return;
        const previousSerial = controls.device.value;
        applySettings(savedConfig);
        if (controls.device.value !== previousSerial) inspectDevice(controls.device.value);
        setStatus('connecting', '正在还原设置');
        try {
            const result = await api.restartStream(savedConfig);
            if (!result.success && !result.cancelled) throw new Error(result.error);
        } catch (error) {
            serviceActive = false;
            setStatus('error', '还原失败', error.message);
            appendLog(t('还原失败 · {error}', { error: error.message }), 'error');
        }
    }

    $('btn-reconfig-keep').addEventListener('click', () => {
        if (!preview) return;
        savedConfig = preview.config;
        clearPreview();
        appendLog(t('已保留新设置。'));
    });
    $('btn-reconfig-revert').addEventListener('click', revertPreview);

    async function startStream() {
        if (serviceActive || stopping) return;
        savedConfig = streamConfig();
        serviceActive = true;
        setStatus('connecting', '正在连接');
        try {
            const result = await api.startStream(savedConfig);
            if (!result.success && !result.cancelled) throw new Error(result.error);
        } catch (error) {
            serviceActive = false;
            setStatus('error', '启动失败', error.message);
            appendLog(t('启动失败 · {error}', { error: error.message }), 'error');
            showPage('diagnostics');
            $('log-drawer').open = true;
        }
    }

    async function stopStream() {
        if (stopping) return;
        stopping = true;
        clearTimeout(restartDebounce);
        clearPreview();
        setStatus('connecting', '正在停止');
        await api.stopStream();
    }

    $('btn-toggle-stream').addEventListener('click', () => serviceActive ? stopStream() : startStream());

    function updateStats(data) {
        $('stat-fps').textContent = data.fps.toFixed(1);
        showText('stat-fps-desc', '采集 {capture} · 编码 {encode}', { capture: data.wgcFps.toFixed(1), encode: data.encodeFps.toFixed(1) });
        $('stat-bitrate').textContent = data.mbps.toFixed(1);
        $('stat-latency').textContent = data.encodeMs.toFixed(2);
        $('stat-encode-tail').textContent = 'P95 ' + data.encodeP95Ms.toFixed(2) + ' ms';
        $('stat-frame-gap').textContent = data.encodeGapP95Ms.toFixed(2) + ' ms';
        $('stat-frames').textContent = data.frames.toLocaleString();
        const total = data.frames + data.dropped;
        const dropped = total ? (data.dropped * 100 / total).toFixed(1) : '0.0';
        showText('badge-drop-rate', '发送队列丢帧 {dropped}%', { dropped });
        $('badge-drop-rate').classList.toggle('warning', data.dropped > 0);
    }

    function resetStats() {
        for (const id of ['stat-fps', 'stat-bitrate', 'stat-latency', 'stat-frames']) $(id).textContent = '—';
        showText('stat-fps-desc', '等待采集');
        $('stat-encode-tail').textContent = 'P95 —';
        $('stat-frame-gap').textContent = '—';
        showText('stream-mode', '等待启动');
        $('card-fps-target').hidden = true;
        showText('badge-drop-rate', '发送队列丢帧 {dropped}%', { dropped: 0 });
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
        } else if (data.type === 'device_selected') {
            appendLog(t('已选择设备 · {name}', { name: data.model || data.serial }));
        } else if (data.type === 'state') {
            if (data.status === 'streaming') {
                const source = displays.find(display => display.index === data.display);
                if (source) {
                    showText('val-display', '{label} · {width} × {height} · Windows {displayHz} Hz', { ...data, label: () => displayLabel(source) });
                }
                showText('stream-mode', '{width} × {height} · {fps} FPS', data);
                showText('card-fps-target', '目标 {fps} FPS', data);
                $('card-fps-target').hidden = false;
                setStatus('streaming', '串流中 · {fps} FPS', undefined, data);
                showPreview(data);
                appendLog(t('串流已建立 · {mode}', { mode: $('stream-mode').textContent }));
            } else if (connectingLabels[data.status]) {
                if (data.status === 'disconnected') resetStats();
                const message = data.status === 'connecting' && data.phase === 'installing' ?
                    '正在安装 Android 应用' : connectingLabels[data.status];
                setStatus('connecting', message, data.message || message);
                appendLog(data.message || t(message));
            } else if (data.status === 'mode_warning' || data.status === 'error') {
                appendLog(data.message, data.status === 'error' ? 'error' : 'warn');
                if (data.status === 'error') setStatus('error', '连接遇到问题', data.message);
            }
        }
    });

    api.onStreamStatus(status => {
        if (preview && !stopping) {
            revertPreview();
            return;
        }
        serviceActive = false;
        stopping = false;
        clearTimeout(restartDebounce);
        clearPreview();
        resetStats();
        if (status.status === 'error') {
            setStatus('error', '串流异常退出', status.message);
            appendLog(status.message || t('串流异常退出。'), 'error');
            showPage('diagnostics');
            $('log-drawer').open = true;
        } else {
            setStatus('idle', '待机就绪');
            loadDisplays();
            appendLog(t('串流已停止。'));
        }
    });

    api.onClientInstalled(serial => {
        if (serial === controls.device.value) setHealth('apk', 'ready', '已就绪');
    });
    api.onTrayAction(data => {
        if (data?.action === 'start') startStream();
        else if (data?.action === 'change-config') {
            manualSettings = true;
            applySettings(data.config);
            settingsChanged();
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
    applyLanguage();
    showPage('connect');
    setStatus('idle', '待机就绪');
    setHealth('apk', '', '等待设备');
    renderUsbResult();
    resetStats();
    appendLog(t('控制中心已就绪。'));
    renderDisplay();
    loadDevices();
    loadDisplays();
})();

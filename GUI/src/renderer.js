document.addEventListener('DOMContentLoaded', () => {
    // Window Controls
    const btnTrayMin = document.getElementById('btn-tray-min');
    const btnMinimize = document.getElementById('btn-minimize');
    const btnMaximize = document.getElementById('btn-maximize');
    const btnClose = document.getElementById('btn-close');

    // Status Pill
    const statusPill = document.getElementById('status-pill');
    const statusText = document.getElementById('status-text');

    // Telemetry Hero Card Elements
    const statFps = document.getElementById('stat-fps');
    const statFpsDesc = document.getElementById('stat-fps-desc');
    const statBitrate = document.getElementById('stat-bitrate');
    const statLatency = document.getElementById('stat-latency');
    const statFrames = document.getElementById('stat-frames');
    const cardFpsTarget = document.getElementById('card-fps-target');
    const badgeUsbTier = document.getElementById('badge-usb-tier');
    const badgeEncoderProto = document.getElementById('badge-encoder-proto');
    const badgeDropRate = document.getElementById('badge-drop-rate');
    const statUsbDesc = document.getElementById('stat-usb-desc');
    const statGpuDesc = document.getElementById('stat-gpu-desc');
    const statProtoDesc = document.getElementById('stat-proto-desc');

    // Unified System Status Bar Elements
    const dotDevice = document.getElementById('dot-device');
    const valDevice = document.getElementById('val-device');
    const dotApk = document.getElementById('dot-apk');
    const valApk = document.getElementById('val-apk');
    const btnStatusApk = document.getElementById('btn-status-apk');
    const dotDisplay = document.getElementById('dot-display');
    const valDisplay = document.getElementById('val-display');
    const dotDriver = document.getElementById('dot-driver');
    const valDriver = document.getElementById('val-driver');
    const btnStatusDriver = document.getElementById('btn-status-driver');

    // Device Controls
    const selectDevice = document.getElementById('select-device');
    const btnRefreshDevices = document.getElementById('btn-refresh-devices');
    const btnTestUsb = document.getElementById('btn-test-usb');
    const btnInstallApk = document.getElementById('btn-install-apk'); // guarded

    // Display & Resolution Controls
    const selectDisplay = document.getElementById('select-display');
    const btnRefreshDisplays = document.getElementById('btn-refresh-displays');
    const btnDriverInstall = document.getElementById('btn-driver-install'); // guarded
    const btnWinDisplay = document.getElementById('btn-win-display');
    const selectResolution = document.getElementById('select-resolution');
    const valResolutionRatio = document.getElementById('val-resolution-ratio');

    // Performance Settings
    const segProfileBtns = document.querySelectorAll('#seg-profile .seg-btn');
    const valProfileTag = document.getElementById('val-profile-tag');
    const segFpsBtns = document.querySelectorAll('#seg-fps .seg-btn');
    const sliderBitrate = document.getElementById('slider-bitrate');
    const valBitrate = document.getElementById('val-bitrate');
    const presetTags = document.querySelectorAll('.preset-tag');
    const segBufferBtns = document.querySelectorAll('#seg-buffermode .seg-btn');
    const switchAutoreconnect = document.getElementById('switch-autoreconnect');

    // Reconfiguration Confirm Banner Elements
    const reconfigBanner = document.getElementById('reconfig-confirm-banner');
    const btnReconfigKeep = document.getElementById('btn-reconfig-keep');
    const btnReconfigRevert = document.getElementById('btn-reconfig-revert');
    const reconfigCountdown = document.getElementById('reconfig-countdown');

    // Action Bar & Drawer
    const btnToggleStream = document.getElementById('btn-toggle-stream');
    const iconStream = document.getElementById('icon-stream');
    const textStream = document.getElementById('text-stream');
    const btnHideTray = document.getElementById('btn-hide-tray');
    const btnToggleLog = document.getElementById('btn-toggle-log');
    const btnClearLog = document.getElementById('btn-clear-log');
    const logDrawer = document.getElementById('log-drawer');
    const logConsole = document.getElementById('log-console');

    // App State
    let isStreaming = false;
    let currentProfile = 'esports';
    let currentFps = 120;
    let currentBitrate = 60;
    let currentWidth = 1752;
    let currentHeight = 2800;
    let currentBufferMode = 'lowlatency';
    let currentOrientation = 'portrait';
    let currentGpuName = '独立 GPU (NVENC)';
    let devicesList = [];
    let displaysList = [];
    let isClientInstalled = false;

    // Snapshot for safe revert & hot reconfig
    let savedConfig = {
        profile: 'esports',
        fps: 120,
        bitrate: 60,
        width: 1752,
        height: 2800,
        bufferMode: 'lowlatency',
        orientation: 'portrait'
    };
    let reconfigTimer = null;
    let reconfigInterval = null;
    let isAwaitingReconfig = false;

    // 1. Window Controls
    btnTrayMin.addEventListener('click', () => window.api.hideToTray());
    btnMinimize.addEventListener('click', () => window.api.minimizeWindow());
    btnMaximize.addEventListener('click', () => window.api.maximizeWindow());
    btnClose.addEventListener('click', () => window.api.closeWindow());
    btnHideTray.addEventListener('click', () => window.api.hideToTray());

    // 2. Logging Helper
    function appendLog(msg, type = 'info') {
        const line = document.createElement('div');
        line.className = `log-line log-${type}`;
        const time = new Date().toLocaleTimeString();
        line.textContent = `[${time}] ${msg}`;
        logConsole.appendChild(line);
        logConsole.scrollTop = logConsole.scrollHeight;
    }

    btnToggleLog.addEventListener('click', () => {
        logDrawer.classList.toggle('collapsed');
    });

    btnClearLog.addEventListener('click', () => {
        logConsole.innerHTML = '';
        appendLog('日志已清空.');
    });

    // 3. Status Pill Updater
    function setStatus(state, message) {
        statusPill.className = `status-badge status-${state}`;
        statusText.textContent = message;

        if (state === 'streaming') {
            isStreaming = true;
            btnToggleStream.classList.add('md3-fab-stop');
            btnToggleStream.classList.remove('md3-fab-primary');
            textStream.textContent = '停止副屏服务';
            iconStream.innerHTML = '<path d="M6 6h12v12H6z"/>';
        } else if (state === 'connecting') {
            textStream.textContent = '正在连接...';
        } else {
            isStreaming = false;
            btnToggleStream.classList.remove('md3-fab-stop');
            btnToggleStream.classList.add('md3-fab-primary');
            textStream.textContent = '启动副屏服务';
            iconStream.innerHTML = '<path d="M8 5v14l11-7z"/>';
        }
    }

    // 4. GPU Information Probing
    async function loadGpuInfo() {
        try {
            const res = await window.api.getGpuInfo();
            if (res && res.gpuName) {
                currentGpuName = res.gpuName;
                statGpuDesc.textContent = currentGpuName; // Only show GPU model, no wrapping text!
            }
        } catch (e) {
            statGpuDesc.textContent = '独立显卡';
        }
    }

    // 5. Device Enumeration & Auto-Adaptation
    async function inspectDevice(serial) {
        if (!serial) return;

        // Check if APK is installed
        try {
            const checkRes = await window.api.checkClientInstalled(serial);
            isClientInstalled = checkRes.installed;
            if (isClientInstalled) {
                dotApk.className = 'status-dot status-dot-online';
                valApk.textContent = '已就绪';
                btnStatusApk.classList.add('hidden');
            } else {
                dotApk.className = 'status-dot status-dot-warning';
                valApk.textContent = '未安装';
                btnStatusApk.classList.remove('hidden');
            }
        } catch (e) {
            dotApk.className = 'status-dot status-dot-offline';
            valApk.textContent = '未知';
            btnStatusApk.classList.add('hidden');
        }

        // Probe Device Specs (Resolution, Refresh Rate, USB Speed)
        try {
            const specs = await window.api.detectDeviceSpecs(serial);
            if (specs.usbTier) {
                statUsbDesc.textContent = specs.usbTier; // No extra prefix to prevent line wrap!
                if (specs.usbTier.includes('10Gbps')) {
                    badgeUsbTier.textContent = 'USB 3.2';
                } else if (specs.usbTier.includes('5Gbps')) {
                    badgeUsbTier.textContent = 'USB 3.0';
                } else {
                    badgeUsbTier.textContent = 'USB 2.0';
                }
            }

            if (specs.width > 0 && specs.height > 0) {
                appendLog(`[规格自适应] 探测到屏幕物理规格: ${specs.width}x${specs.height} @${specs.fps}Hz`);

                // Auto-set resolution & orientation dropdown
                setResolution(specs.width, specs.height, false);

                // Auto-select FPS button matching device
                if (specs.fps >= 120) {
                    setFps(120, false, false);
                } else if (specs.fps >= 90) {
                    setFps(90, false, false);
                } else {
                    setFps(60, false, false);
                }
            }
        } catch (e) {
            appendLog(`探测设备屏幕规格失败: ${e.message}`, 'warn');
        }
    }

    async function loadDevices() {
        appendLog('正在扫描连接的 ADB 设备...');
        try {
            devicesList = await window.api.getDevices();
            selectDevice.innerHTML = '';

            if (devicesList.length === 0) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = '未检测到设备 (请插上 USB 数据线并开启开发者调试)';
                selectDevice.appendChild(opt);
                dotDevice.className = 'status-dot status-dot-offline';
                valDevice.textContent = '未连接设备';
                dotApk.className = 'status-dot status-dot-offline';
                valApk.textContent = '等待设备';
                btnStatusApk.classList.add('hidden');
                appendLog('未发现已连接的 ADB 设备', 'warn');
                return;
            }

            devicesList.forEach((dev, idx) => {
                const opt = document.createElement('option');
                opt.value = dev.serial;
                const isTab = dev.is_tablet;
                opt.textContent = `${dev.model} (${dev.serial})${isTab ? '  ★ [检测为平板]' : ''}`;
                if (isTab || idx === 0) {
                    opt.selected = true;
                }
                selectDevice.appendChild(opt);
            });

            const currentSerial = selectDevice.value;
            const chosenDev = devicesList.find(d => d.serial === currentSerial) || devicesList[0];
            dotDevice.className = 'status-dot status-dot-online';
            valDevice.textContent = chosenDev.model;

            appendLog(`发现 ${devicesList.length} 台设备，当前就绪: ${chosenDev.model}`);
            inspectDevice(currentSerial);
        } catch (e) {
            appendLog(`扫描设备失败: ${e.message}`, 'error');
        }
    }

    selectDevice.addEventListener('change', () => {
        const serial = selectDevice.value;
        const dev = devicesList.find(d => d.serial === serial);
        if (dev) {
            dotDevice.className = 'status-dot status-dot-online';
            valDevice.textContent = dev.model;
            appendLog(`切换目标设备: ${dev.model} (${dev.serial})`);
            inspectDevice(serial);
        }
    });

    btnRefreshDevices.addEventListener('click', loadDevices);

    // 6. USB Cable Benchmark Test
    btnTestUsb.addEventListener('click', async () => {
        const serial = selectDevice.value;
        if (!serial) {
            appendLog('请先连接安卓设备', 'warn');
            return;
        }

        btnTestUsb.disabled = true;
        btnTestUsb.textContent = '测速中...';
        appendLog('正在对 USB 数据链路进行带宽推流压力测试 (10MB)...');

        try {
            const res = await window.api.testUsbSpeed(serial);
            if (res.success) {
                statUsbDesc.textContent = `${res.speedMBps} MB/s · ${res.tier}`; // Concise: e.g. 1176.9 MB/s · USB 3.2 Gen 2
                badgeUsbTier.textContent = res.tier.includes('10Gbps') ? 'USB 3.2' : (res.tier.includes('5Gbps') ? 'USB 3.0' : 'USB 2.0');
                appendLog(`[USB 测速结果] 传输带宽: ${res.speedMBps} MB/s (${res.tier})`);
            } else {
                appendLog(`测速失败: ${res.error}`, 'error');
            }
        } catch (e) {
            appendLog(`测速发生异常: ${e.message}`, 'error');
        } finally {
            btnTestUsb.disabled = false;
            btnTestUsb.textContent = '测速';
        }
    });

    // 7. Client APK Install Action
    async function triggerApkInstall() {
        const serial = selectDevice.value;
        if (!serial) {
            appendLog('请先连接安卓设备', 'warn');
            return;
        }

        if (btnInstallApk) {
            btnInstallApk.disabled = true;
            btnInstallApk.textContent = '安装中...';
        }
        btnStatusApk.disabled = true;
        btnStatusApk.textContent = '安装中...';
        dotApk.className = 'status-dot status-dot-warning';
        valApk.textContent = '正在安装...';
        appendLog('正在向设备推送并安装 ReDisplay.apk...');

        try {
            const res = await window.api.installClientApk(serial);
            if (res.success) {
                isClientInstalled = true;
                dotApk.className = 'status-dot status-dot-online';
                valApk.textContent = '已就绪';
                btnStatusApk.classList.add('hidden');
                appendLog('ReDisplay 客户端安装成功！', 'info');
            } else {
                dotApk.className = 'status-dot status-dot-warning';
                valApk.textContent = '未安装';
                btnStatusApk.classList.remove('hidden');
                appendLog(`安装客户端失败: ${res.error}`, 'error');
            }
        } catch (e) {
            appendLog(`安装客户端异常: ${e.message}`, 'error');
        } finally {
            if (btnInstallApk) {
                btnInstallApk.disabled = false;
                btnInstallApk.textContent = '安装客户端';
            }
            btnStatusApk.disabled = false;
            btnStatusApk.textContent = '安装';
        }
    }

    if (btnInstallApk) {
        btnInstallApk.addEventListener('click', triggerApkInstall);
    }
    btnStatusApk.addEventListener('click', triggerApkInstall);

    // 8. Display & Driver Management
    async function loadDisplays() {
        appendLog('正在检测 Windows 显示拓扑...');
        try {
            displaysList = await window.api.getDisplays();
            selectDisplay.innerHTML = '';

            const autoOpt = document.createElement('option');
            autoOpt.value = '-1';
            autoOpt.textContent = '自动选择 (优先 Virtual Display Driver 虚拟副屏)';
            selectDisplay.appendChild(autoOpt);

            let vddFound = false;
            displaysList.forEach((d) => {
                const opt = document.createElement('option');
                opt.value = d.index;
                const tag = d.isVirtual ? '  ★ [虚拟副屏]' : (d.isPrimary ? ' [主显示器]' : ' [扩展显示器]');
                opt.textContent = `显示器 ${d.index}: ${d.name} (${d.width}x${d.height} @${d.fps}Hz) ${tag}`;
                if (d.isVirtual) {
                    opt.selected = true;
                    vddFound = true;
                    valDisplay.textContent = `${d.width}×${d.height} @${d.fps}Hz`;
                    dotDisplay.className = 'status-dot status-dot-online';
                    statFpsDesc.textContent = `Windows DWM · ${d.fps}Hz`;
                }
                selectDisplay.appendChild(opt);
            });

            if (!vddFound) {
                if (displaysList.length > 0) {
                    valDisplay.textContent = `${displaysList[0].width}×${displaysList[0].height} @${displaysList[0].fps}Hz`;
                    dotDisplay.className = 'status-dot status-dot-online';
                } else {
                    valDisplay.textContent = '未连接副屏';
                    dotDisplay.className = 'status-dot status-dot-offline';
                }
            }

            const driverInstalled = await window.api.checkDriverStatus();
            if (driverInstalled || vddFound) {
                valDriver.textContent = '正常驱动中';
                dotDriver.className = 'status-dot status-dot-online';
                btnStatusDriver.classList.add('hidden');
            } else {
                valDriver.textContent = '未检测到';
                dotDriver.className = 'status-dot status-dot-warning';
                btnStatusDriver.classList.remove('hidden');
            }
        } catch (e) {
            appendLog(`检测显示器失败: ${e.message}`, 'error');
        }
    }

    btnRefreshDisplays.addEventListener('click', loadDisplays);
    btnWinDisplay.addEventListener('click', () => window.api.openDisplaySettings());
    selectDisplay.addEventListener('change', () => {
        const val = selectDisplay.value;
        const disp = displaysList.find(d => String(d.index) === val);
        if (disp) {
            valDisplay.textContent = `${disp.width}×${disp.height} @${disp.fps}Hz`;
            dotDisplay.className = 'status-dot status-dot-online';
            appendLog(`切换捕获显示器: ${disp.name} (${disp.width}x${disp.height})`);
        }
        if (isStreaming) {
            triggerHotReconfig();
        }
    });

    async function triggerDriverInstall() {
        if (btnDriverInstall) {
            btnDriverInstall.disabled = true;
            btnDriverInstall.textContent = '执行中...';
        }
        btnStatusDriver.disabled = true;
        btnStatusDriver.textContent = '安装中...';
        appendLog('正在请求 Windows 管理员权限安装/重置虚拟显示器驱动...');

        try {
            const res = await window.api.manageDriver('install');
            if (res.success) {
                appendLog('虚拟副屏驱动部署命令执行完毕，正在重新枚举显示器...', 'info');
                setTimeout(loadDisplays, 1500);
            } else {
                appendLog(`驱动安装未成功: ${res.error}`, 'warn');
            }
        } catch (e) {
            appendLog(`驱动安装异常: ${e.message}`, 'error');
        } finally {
            if (btnDriverInstall) {
                btnDriverInstall.disabled = false;
                btnDriverInstall.textContent = '装驱动';
            }
            btnStatusDriver.disabled = false;
            btnStatusDriver.textContent = '安装';
        }
    }

    if (btnDriverInstall) {
        btnDriverInstall.addEventListener('click', triggerDriverInstall);
    }
    btnStatusDriver.addEventListener('click', triggerDriverInstall);

    // 9. Hot Reconfiguration & Confirmation Banner (Windows Style)
    function buildStreamConfig() {
        const chosenSerial = selectDevice.value;
        const chosenDisplay = selectDisplay.value;
        return {
            serial: chosenSerial || '',
            display: chosenDisplay !== '-1' ? parseInt(chosenDisplay, 10) : null,
            fps: currentFps,
            bitrate: currentBitrate,
            width: currentWidth,
            height: currentHeight,
            bufferMode: currentBufferMode,
            orientation: currentOrientation,
            port: 27183
        };
    }

    function captureCurrentConfig() {
        return {
            profile: currentProfile,
            fps: currentFps,
            bitrate: currentBitrate,
            width: currentWidth,
            height: currentHeight,
            bufferMode: currentBufferMode,
            orientation: currentOrientation
        };
    }

    function applyConfigToUI(cfg) {
        if (!cfg) return;
        currentProfile = cfg.profile || 'custom';
        setProfile(cfg.profile || 'custom', false, false);
        setFps(cfg.fps || 120, false, false);
        setBitrate(cfg.bitrate || 60, false, false);
        setBufferMode(cfg.bufferMode || 'lowlatency', false, false);
        if (cfg.width && cfg.height) {
            setResolution(cfg.width, cfg.height, false);
        } else if (cfg.orientation) {
            setOrientation(cfg.orientation, false);
        }
    }

    let reconfigDebounceTimer = null;
    let isReconfiguringHot = false;

    function triggerHotReconfig() {
        if (!isStreaming) return;
        if (reconfigDebounceTimer) clearTimeout(reconfigDebounceTimer);
        reconfigDebounceTimer = setTimeout(async () => {
            if (isReconfiguringHot) return;
            isReconfiguringHot = true;

            if (!isAwaitingReconfig) {
                isAwaitingReconfig = true;
            }

            const newCfg = buildStreamConfig();
            appendLog(`[热生效] 正在按新配置重启服务 (${newCfg.width}x${newCfg.height} @${newCfg.fps}Hz, ${newCfg.bitrate}Mbps, 缓冲策略:${newCfg.bufferMode})...`, 'info');

            try {
                const res = await window.api.restartStream(newCfg);
                if (!res.success) {
                    appendLog(`热重启异常: ${res.error}`, 'error');
                    revertReconfig();
                    return;
                }
                showReconfigBanner();
            } catch (e) {
                appendLog(`热重启发生错误: ${e.message}`, 'error');
                revertReconfig();
            } finally {
                isReconfiguringHot = false;
            }
        }, 150);
    }

    function showReconfigBanner() {
        if (reconfigTimer) clearTimeout(reconfigTimer);
        if (reconfigInterval) clearInterval(reconfigInterval);

        reconfigBanner.classList.remove('hidden');
        let remainingSec = 10;
        reconfigCountdown.textContent = remainingSec;

        reconfigInterval = setInterval(() => {
            remainingSec--;
            if (reconfigCountdown) reconfigCountdown.textContent = remainingSec;
            if (remainingSec <= 0) {
                clearInterval(reconfigInterval);
            }
        }, 1000);

        reconfigTimer = setTimeout(() => {
            appendLog('[自动保护] 10秒未确认，正在自动回退先前设置...', 'warn');
            revertReconfig();
        }, 10000);
    }

    function hideReconfigBanner() {
        if (reconfigTimer) { clearTimeout(reconfigTimer); reconfigTimer = null; }
        if (reconfigInterval) { clearInterval(reconfigInterval); reconfigInterval = null; }
        reconfigBanner.classList.add('hidden');
        isAwaitingReconfig = false;
    }

    function keepReconfig() {
        hideReconfigBanner();
        savedConfig = captureCurrentConfig();
        appendLog('新显示与编码配置已成功保存！', 'info');
        window.api.notifyConfigChanged(buildStreamConfig());
    }

    async function revertReconfig() {
        hideReconfigBanner();
        appendLog('正在将所有参数回退至先前配置...', 'warn');
        applyConfigToUI(savedConfig);
        if (isStreaming) {
            const restoredCfg = buildStreamConfig();
            await window.api.restartStream(restoredCfg);
            appendLog('已恢复先前配置并重新建立串流。', 'info');
        }
    }

    btnReconfigKeep.addEventListener('click', keepReconfig);
    btnReconfigRevert.addEventListener('click', revertReconfig);

    // 10. Generic Resolution & Display Orientation Dropdown
    function setResolution(w, h, notifyRestart = true) {
        currentWidth = w;
        currentHeight = h;
        currentOrientation = (h > w) ? 'portrait' : 'landscape';

        const val = `${w}x${h}`;
        let found = false;
        for (const opt of selectResolution.options) {
            if (opt.value === val) {
                selectResolution.value = val;
                found = true;
                break;
            }
        }
        if (!found) {
            const maxDim = Math.max(w, h);
            let specTag = (maxDim >= 2700) ? '2.8K' : (maxDim >= 2400 ? '2.5K' : (maxDim >= 1800 ? '2K' : '1080P'));
            const orientTag = (currentOrientation === 'portrait') ? '竖屏' : '横屏';
            const newOpt = document.createElement('option');
            newOpt.value = val;
            newOpt.textContent = `${w} × ${h} (${specTag} ${orientTag} · 自适应)`;
            selectResolution.insertBefore(newOpt, selectResolution.firstChild);
            selectResolution.value = val;
        }

        // Update ratio badge
        const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
        const g = gcd(w, h);
        const rw = w / g;
        const rh = h / g;
        const orientLabel = (currentOrientation === 'portrait') ? '纵向竖屏' : '横向宽屏';
        if ((rw === 16 && rh === 10) || (rw === 10 && rh === 16)) {
            valResolutionRatio.textContent = `16:10 ${orientLabel}`;
        } else if ((rw === 16 && rh === 9) || (rw === 9 && rh === 16)) {
            valResolutionRatio.textContent = `16:9 ${orientLabel}`;
        } else {
            valResolutionRatio.textContent = `${rw}:${rh} ${orientLabel}`;
        }

        appendLog(`副屏分辨率设置为: ${w} × ${h} (${orientLabel})`);
        window.api.notifyConfigChanged(buildStreamConfig());
        if (notifyRestart) triggerHotReconfig();
    }

    selectResolution.addEventListener('change', () => {
        const [w, h] = selectResolution.value.split('x').map(Number);
        if (w && h) {
            setResolution(w, h, true);
        }
    });

    function setOrientation(orient, notifyRestart = true) {
        if (orient === 'portrait' && currentWidth > currentHeight) {
            setResolution(currentHeight, currentWidth, notifyRestart);
        } else if (orient === 'landscape' && currentHeight > currentWidth) {
            setResolution(currentHeight, currentWidth, notifyRestart);
        }
    }

    // 11. Performance Profiles (Gear Selection)
    function setProfile(profile, log = true, notifyRestart = true) {
        currentProfile = profile;
        segProfileBtns.forEach(b => {
            if (b.dataset.profile === profile) {
                b.classList.add('active');
            } else {
                b.classList.remove('active');
            }
        });

        if (profile === 'esports') {
            valProfileTag.textContent = '120Hz 极速电竞直通';
            setFps(120, false, false);
            setBitrate(60, false, false);
            setBufferMode('lowlatency', false, false);
            if (log) appendLog('切换档位: ⚡ 120Hz 极速电竞直通 (120Hz · 60Mbps · ≤10ms 极低延迟)');
        } else if (profile === 'quality') {
            valProfileTag.textContent = '120Hz 极致超清画质';
            setFps(120, false, false);
            setBitrate(85, false, false);
            setBufferMode('lowlatency', false, false);
            if (log) appendLog('切换档位: 🎬 120Hz 极致超清画质 (120Hz · 85Mbps · 高保真超清)');
        } else if (profile === 'office') {
            valProfileTag.textContent = '60Hz 节能办公模式';
            setFps(60, false, false);
            setBitrate(30, false, false);
            setBufferMode('smooth', false, false);
            if (log) appendLog('切换档位: 🔋 60Hz 节能办公模式 (60Hz · 30Mbps · 平滑低功耗)');
        } else if (profile === 'custom') {
            valProfileTag.textContent = '自定义调优';
        }

        window.api.notifyConfigChanged(buildStreamConfig());
        if (notifyRestart) triggerHotReconfig();
    }

    function markCustomProfile() {
        currentProfile = 'custom';
        segProfileBtns.forEach(b => {
            if (b.dataset.profile === 'custom') {
                b.classList.add('active');
            } else {
                b.classList.remove('active');
            }
        });
        valProfileTag.textContent = '自定义调优';
        window.api.notifyConfigChanged(buildStreamConfig());
    }

    segProfileBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            setProfile(btn.dataset.profile, true, true);
        });
    });

    // 12. Refresh Rate Selection
    function setFps(fps, markCustom = true, notifyRestart = true) {
        currentFps = fps;
        segFpsBtns.forEach(b => {
            if (parseInt(b.dataset.fps, 10) === fps) {
                b.classList.add('active');
            } else {
                b.classList.remove('active');
            }
        });
        cardFpsTarget.textContent = `${currentFps} Hz`;
        if (markCustom) markCustomProfile();
        window.api.notifyConfigChanged(buildStreamConfig());
        if (notifyRestart) triggerHotReconfig();
    }

    segFpsBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            setFps(parseInt(btn.dataset.fps, 10), true, true);
            appendLog(`选择目标刷新率: ${currentFps} Hz`);
        });
    });

    // 13. Bitrate Slider & Presets
    function setBitrate(val, markCustom = true, notifyRestart = true) {
        currentBitrate = val;
        sliderBitrate.value = val;
        valBitrate.textContent = `${val} Mbps`;
        updatePresetTags(val);
        if (markCustom) markCustomProfile();
        window.api.notifyConfigChanged(buildStreamConfig());
        if (notifyRestart) triggerHotReconfig();
    }

    sliderBitrate.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        currentBitrate = val;
        valBitrate.textContent = `${val} Mbps`;
        updatePresetTags(val);
        markCustomProfile();
    });

    sliderBitrate.addEventListener('change', (e) => {
        const val = parseInt(e.target.value, 10);
        setBitrate(val, true, true);
    });

    function updatePresetTags(val) {
        presetTags.forEach(tag => {
            if (parseInt(tag.dataset.val, 10) === val) {
                tag.classList.add('active-tag');
            } else {
                tag.classList.remove('active-tag');
            }
        });
    }

    presetTags.forEach(tag => {
        tag.addEventListener('click', () => {
            const val = parseInt(tag.dataset.val, 10);
            setBitrate(val, true, true);
            appendLog(`选择码率预设: ${val} Mbps`);
        });
    });

    // 14. Buffer Mode Selection
    function setBufferMode(mode, markCustom = true, notifyRestart = true) {
        currentBufferMode = mode;
        segBufferBtns.forEach(b => {
            if (b.dataset.mode === mode) {
                b.classList.add('active');
            } else {
                b.classList.remove('active');
            }
        });
        if (markCustom) markCustomProfile();
        window.api.notifyConfigChanged(buildStreamConfig());
        if (notifyRestart) triggerHotReconfig();
    }

    segBufferBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            setBufferMode(btn.dataset.mode, true, true);
            appendLog(`延迟控制策略切换为: ${btn.textContent.trim()}`);
        });
    });

    // 15. Start / Stop Streaming Pipeline
    async function startStream() {
        const chosenSerial = selectDevice.value;

        // Auto-check APK before streaming
        if (chosenSerial && !isClientInstalled) {
            appendLog('客户端尚未安装，正在自动向安卓设备静默部署 ReDisplay.apk...', 'warn');
            setStatus('connecting', '部署客户端 APK...');
            valApk.textContent = '正在部署...';
            dotApk.className = 'status-dot status-dot-warning';
            const installRes = await window.api.installClientApk(chosenSerial);
            if (!installRes.success) {
                setStatus('error', 'APK 安装失败');
                valApk.textContent = '安装失败';
                appendLog(`自动安装客户端 APK 失败: ${installRes.error}`, 'error');
                return;
            }
            isClientInstalled = true;
            valApk.textContent = '已就绪';
            dotApk.className = 'status-dot status-dot-online';
            btnStatusApk.classList.add('hidden');
            appendLog('客户端 APK 部署成功，继续启动串流...', 'info');
        }

        const config = buildStreamConfig();
        savedConfig = captureCurrentConfig(); // Sync savedConfig on initial start

        setStatus('connecting', '正在初始化...');
        appendLog(`启动串流: 目标=${config.serial || '自动'} | 显示器=${config.display !== null ? config.display : '自动'} | ${config.width}x${config.height} @${config.fps}Hz | ${config.bitrate}Mbps | 缓冲:${config.bufferMode}`);

        const res = await window.api.startStream(config);
        if (!res.success) {
            setStatus('error', '启动失败');
            appendLog(`启动失败: ${res.error}`, 'error');
        }
    }

    async function stopStream() {
        const chosenSerial = selectDevice.value;
        hideReconfigBanner();
        setStatus('idle', '待机就绪');
        appendLog('正在停止副屏服务并释放通道...');
        await window.api.stopStream(chosenSerial);
        resetStats();
        appendLog('副屏服务已停止，通道已清理，安卓端已退出占用。', 'info');
    }

    btnToggleStream.addEventListener('click', () => {
        if (isStreaming) {
            stopStream();
        } else {
            startStream();
        }
    });

    function resetStats() {
        statFps.textContent = '0.0';
        statBitrate.textContent = '0.0';
        statLatency.textContent = '0.0';
        statFrames.textContent = '0';
        badgeDropRate.textContent = '丢帧率 0.0%';
        badgeDropRate.classList.remove('stat-badge-warning');
    }

    // 14. Listen to Stream Events
    window.api.onStreamEvent((data) => {
        if (data.type === 'stats') {
            statFps.textContent = data.fps.toFixed(1);
            statBitrate.textContent = data.mbps.toFixed(1);
            statLatency.textContent = data.encodeMs.toFixed(2);
            statFrames.textContent = data.frames.toLocaleString();
            if (data.dropped && data.dropped > 0) {
                const total = data.frames + data.dropped;
                const dropPct = ((data.dropped / total) * 100).toFixed(1);
                badgeDropRate.textContent = `丢帧率 ${dropPct}%`;
                badgeDropRate.classList.add('stat-badge-warning');
            } else {
                badgeDropRate.textContent = '丢帧率 0.0%';
                badgeDropRate.classList.remove('stat-badge-warning');
            }
        } else if (data.type === 'state') {
            if (data.status === 'streaming') {
                setStatus('streaming', `串流中 (${data.fps || currentFps}Hz)`);
                appendLog(`[Stream] 正在直推 -> ${data.width}x${data.height} @${data.fps}Hz (${data.bitrate} Mbps)`);
                if (data.device) {
                    valDevice.textContent = data.device;
                }
            } else if (data.status === 'connecting' || data.status === 'detecting_devices' || data.status === 'launching_app') {
                setStatus('connecting', data.message || '连接中...');
                appendLog(`[Host] ${data.message || data.status}`);
            } else if (data.status === 'waiting_device') {
                setStatus('connecting', '等待设备接入...');
                appendLog('[Host] 等待安卓设备通过 USB 连接...');
            } else if (data.status === 'disconnected') {
                setStatus('connecting', '连接断开，正在重连...');
                appendLog(`[Host] ${data.message || '连接断开，自动重连中...'}`, 'warn');
            } else if (data.status === 'error') {
                setStatus('error', data.message || '发生错误');
                appendLog(`[Host Error] ${data.message}`, 'error');
            }
        } else if (data.type === 'device_selected') {
            appendLog(`[Host] 绑定设备: ${data.model} (${data.serial})`);
            valDevice.textContent = data.model;
        }
    });

    window.api.onStreamStatus((status) => {
        if (status.status === 'stopped') {
            if (isAwaitingReconfig) {
                // Ignore transient stopped event during hot-restart
                appendLog('副屏通道正在重启并应用新配置...', 'info');
                return;
            }
            setStatus('idle', '待机中');
            appendLog(`副屏服务已停止 (代码: ${status.code || 0})`);
            resetStats();
        } else if (status.status === 'error') {
            if (isAwaitingReconfig) {
                appendLog(`热重启过程中出现波动: ${status.message || ''}`, 'warn');
                return;
            }
            setStatus('error', status.message || '服务异常退出');
            appendLog(`副屏服务错误: ${status.message}`, 'error');
            resetStats();
        }
    });

    // 16. Tray Action Listener
    window.api.onTrayAction((data) => {
        if (!data) return;
        if (data.action === 'start') {
            if (!isStreaming) startStream();
        } else if (data.action === 'stop') {
            if (isStreaming) stopStream();
        } else if (data.action === 'change-config') {
            applyConfigToUI(data.config);
            if (isStreaming) {
                triggerHotReconfig();
            }
        }
    });

    // Initial load
    loadGpuInfo();
    loadDevices();
    loadDisplays();
});

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    // Window controls
    minimizeWindow: () => ipcRenderer.send('window-minimize'),
    maximizeWindow: () => ipcRenderer.send('window-maximize'),
    closeWindow: () => ipcRenderer.send('window-close'),
    hideToTray: () => ipcRenderer.send('window-hide-to-tray'),
    setLanguage: language => ipcRenderer.send('set-language', language),

    // Service controls
    startStream: (config) => ipcRenderer.invoke('start-stream', config),
    stopStream: () => ipcRenderer.invoke('stop-stream'),
    restartStream: (config) => ipcRenderer.invoke('restart-stream', config),
    getServiceStatus: () => ipcRenderer.invoke('get-service-status'),

    // Detection & Hardware
    getDevices: () => ipcRenderer.invoke('get-devices'),
    getDeviceStates: () => ipcRenderer.invoke('get-device-states'),
    getAdbPath: () => ipcRenderer.invoke('get-adb-path'),
    chooseAdbFolder: () => ipcRenderer.invoke('choose-adb-folder'),
    downloadAdb: () => ipcRenderer.invoke('download-adb'),
    openAdbDownloadPage: () => ipcRenderer.invoke('open-adb-download-page'),
    exportPerformanceReport: () => ipcRenderer.invoke('export-performance-report'),
    onReportAvailable: callback => ipcRenderer.on('report-available', () => callback()),
    getDisplays: () => ipcRenderer.invoke('get-displays'),
    getGpuInfo: () => ipcRenderer.invoke('get-gpu-info'),
    detectDeviceSpecs: (serial) => ipcRenderer.invoke('detect-device-specs', serial),
    testUsbSpeed: (serial) => ipcRenderer.invoke('test-usb-speed', serial),

    // Client APK Management
    checkClientInstalled: (serial) => ipcRenderer.invoke('check-client-installed', serial),
    installClientApk: (serial) => ipcRenderer.invoke('install-client-apk', serial),

    // Driver & Windows Settings
    getDriverInfo: () => ipcRenderer.invoke('get-driver-info'),
    manageDriver: (action, serial) => ipcRenderer.invoke('manage-driver', action, serial),
    openDisplaySettings: () => ipcRenderer.invoke('open-display-settings'),

    // Event listeners
    onStreamEvent: (callback) => {
        const handler = (event, data) => callback(data);
        ipcRenderer.on('stream-event', handler);
        return () => ipcRenderer.removeListener('stream-event', handler);
    },
    onStreamStatus: (callback) => {
        const handler = (event, data) => callback(data);
        ipcRenderer.on('stream-status', handler);
        return () => ipcRenderer.removeListener('stream-status', handler);
    },
    notifyConfigChanged: (config) => ipcRenderer.send('config-changed', config),
    onClientInstalled: (callback) => {
        const handler = (event, serial) => callback(serial);
        ipcRenderer.on('client-installed', handler);
        return () => ipcRenderer.removeListener('client-installed', handler);
    },
    onTrayAction: (callback) => {
        const handler = (event, data) => callback(data);
        ipcRenderer.on('tray-action', handler);
        return () => ipcRenderer.removeListener('tray-action', handler);
    }
});

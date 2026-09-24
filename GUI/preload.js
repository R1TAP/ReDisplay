const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    // Window controls
    minimizeWindow: () => ipcRenderer.send('window-minimize'),
    maximizeWindow: () => ipcRenderer.send('window-maximize'),
    closeWindow: () => ipcRenderer.send('window-close'),
    hideToTray: () => ipcRenderer.send('window-hide-to-tray'),

    // Service controls
    startStream: (config) => ipcRenderer.invoke('start-stream', config),
    stopStream: (serial) => ipcRenderer.invoke('stop-stream', serial),
    restartStream: (config) => ipcRenderer.invoke('restart-stream', config),
    getServiceStatus: () => ipcRenderer.invoke('get-service-status'),

    // Detection & Hardware
    getDevices: () => ipcRenderer.invoke('get-devices'),
    getDisplays: () => ipcRenderer.invoke('get-displays'),
    getGpuInfo: () => ipcRenderer.invoke('get-gpu-info'),
    detectDeviceSpecs: (serial) => ipcRenderer.invoke('detect-device-specs', serial),
    testUsbSpeed: (serial) => ipcRenderer.invoke('test-usb-speed', serial),

    // Client APK Management
    checkClientInstalled: (serial) => ipcRenderer.invoke('check-client-installed', serial),
    installClientApk: (serial) => ipcRenderer.invoke('install-client-apk', serial),

    // Driver & Windows Settings
    checkDriverStatus: () => ipcRenderer.invoke('check-driver-status'),
    manageDriver: (action) => ipcRenderer.invoke('manage-driver', action),
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
    onTrayAction: (callback) => {
        const handler = (event, data) => callback(data);
        ipcRenderer.on('tray-action', handler);
        return () => ipcRenderer.removeListener('tray-action', handler);
    }
});

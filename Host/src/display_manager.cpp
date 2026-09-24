#include "display_manager.h"
#include <iostream>
#include <map>

struct AdapterInfo {
    std::wstring deviceString;
    std::wstring deviceId;
    bool isVirtual;
};

struct EnumParam {
    std::vector<DisplayInfo>* list;
    std::map<std::wstring, AdapterInfo>* adapters;
};

static BOOL CALLBACK MonitorEnumProc(HMONITOR hMonitor, HDC hdcMonitor, LPRECT lprcMonitor, LPARAM dwData) {
    EnumParam* param = reinterpret_cast<EnumParam*>(dwData);

    MONITORINFOEXW mi = { sizeof(MONITORINFOEXW) };
    if (GetMonitorInfoW(hMonitor, &mi)) {
        DEVMODEW dm = { sizeof(dm) };
        EnumDisplaySettingsW(mi.szDevice, ENUM_CURRENT_SETTINGS, &dm);

        DisplayInfo info;
        info.index = (int)param->list->size();
        info.hMonitor = hMonitor;
        info.deviceName = mi.szDevice;
        info.rect = mi.rcMonitor;
        info.width = (dm.dmPelsWidth > 0) ? dm.dmPelsWidth : (mi.rcMonitor.right - mi.rcMonitor.left);
        info.height = (dm.dmPelsHeight > 0) ? dm.dmPelsHeight : (mi.rcMonitor.bottom - mi.rcMonitor.top);
        info.fps = (dm.dmDisplayFrequency > 0) ? dm.dmDisplayFrequency : 60;
        info.isPrimary = (mi.dwFlags & MONITORINFOF_PRIMARY) != 0;
        info.isVirtual = false;

        auto it = param->adapters->find(mi.szDevice);
        if (it != param->adapters->end()) {
            info.adapterName = it->second.deviceString;
            info.isVirtual = it->second.isVirtual;
        }

        param->list->push_back(info);
    }
    return TRUE;
}

std::vector<DisplayInfo> DisplayManager::EnumerateDisplays() {
    // 1. Map each DISPLAY device to its graphics adapter
    std::map<std::wstring, AdapterInfo> adapters;
    DISPLAY_DEVICEW dd = { sizeof(dd) };
    for (DWORD i = 0; EnumDisplayDevicesW(NULL, i, &dd, 0); i++) {
        if (dd.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP) {
            AdapterInfo info;
            info.deviceString = dd.DeviceString;
            info.deviceId = dd.DeviceID;
            info.isVirtual = (info.deviceString.find(L"Virtual") != std::wstring::npos ||
                              info.deviceString.find(L"VDD") != std::wstring::npos ||
                              info.deviceId.find(L"MTTVDD") != std::wstring::npos ||
                              info.deviceId.find(L"ROOT\\DISPLAY") != std::wstring::npos);
            adapters[dd.DeviceName] = info;
        }
    }

    // 2. Enumerate active desktop monitors
    std::vector<DisplayInfo> list;
    EnumParam param = { &list, &adapters };
    EnumDisplayMonitors(NULL, NULL, MonitorEnumProc, reinterpret_cast<LPARAM>(&param));
    return list;
}

DisplayInfo DisplayManager::PickTargetDisplay(int preferredIndex, int prefWidth, int prefHeight) {
    auto displays = EnumerateDisplays();
    if (displays.empty()) {
        DisplayInfo fallback = { 0 };
        return fallback;
    }

    // 1. Explicit user choice via config or CLI
    if (preferredIndex >= 0 && preferredIndex < (int)displays.size()) {
        return displays[preferredIndex];
    }

    // 2. TOP PRIORITY: Any detected Virtual Display Adapter (e.g. Root\MttVDD)
    for (const auto& d : displays) {
        if (d.isVirtual) {
            return d;
        }
    }

    // 3. Match tablet native resolution (2800x1752 in landscape or portrait)
    for (const auto& d : displays) {
        if ((d.width == prefWidth && d.height == prefHeight) ||
            (d.width == prefHeight && d.height == prefWidth)) {
            return d;
        }
    }

    // 4. Non-primary display that matches orientation (landscape for landscape)
    bool tabletLandscape = (prefWidth >= prefHeight);
    for (const auto& d : displays) {
        bool dispLandscape = (d.width >= d.height);
        if (!d.isPrimary && (dispLandscape == tabletLandscape)) {
            return d;
        }
    }

    // 5. Prefer primary landscape display over vertical secondary
    if (tabletLandscape) {
        for (const auto& d : displays) {
            if (d.width >= d.height) {
                return d;
            }
        }
    }

    // 6. Fallback to first display
    return displays[0];
}

bool DisplayManager::IsVddDriverInstalled() {
    DWORD attr = GetFileAttributesA("C:\\VirtualDisplayDriver\\vdd_settings.xml");
    return (attr != INVALID_FILE_ATTRIBUTES);
}

#pragma once
#include <windows.h>
#include <vector>
#include <string>

struct DisplayInfo {
    int index;
    HMONITOR hMonitor;
    std::wstring deviceName;
    std::wstring adapterName;
    RECT rect;
    int width;
    int height;
    int fps;
    bool isPrimary;
    bool isVirtual;
};

class DisplayManager {
public:
    static std::vector<DisplayInfo> EnumerateDisplays();
    static DisplayInfo PickTargetDisplay(int preferredIndex = -1, int prefWidth = 2800, int prefHeight = 1752);
    static bool IsVddDriverInstalled();
};

#include "adb.h"
#include <windows.h>
#include <iostream>
#include <sstream>
#include <vector>

AdbManager::AdbManager() {
    FindAdbPath();
}

bool AdbManager::FindAdbPath() {
    // 1. Current directory
    if (GetFileAttributesA("adb.exe") != INVALID_FILE_ATTRIBUTES) {
        m_adbPath = "adb.exe";
        return true;
    }
    // 2. Relative resources/bin directory
    const char* relPaths[] = {
        "resources\\bin\\adb.exe",
        "..\\resources\\bin\\adb.exe",
        "..\\ReDisplay-Win64\\resources\\bin\\adb.exe",
        "bin\\adb.exe",
        "..\\bin\\adb.exe"
    };
    for (const char* p : relPaths) {
        if (GetFileAttributesA(p) != INVALID_FILE_ATTRIBUTES) {
            char fullP[MAX_PATH];
            GetFullPathNameA(p, MAX_PATH, fullP, NULL);
            m_adbPath = fullP;
            return true;
        }
    }
    // 3. QtScrcpy path
    const char* qtPath = "C:\\Program Files\\QtScrcpy-win-x64-v3.2.0\\adb.exe";
    if (GetFileAttributesA(qtPath) != INVALID_FILE_ATTRIBUTES) {
        m_adbPath = qtPath;
        return true;
    }
    // 4. System PATH
    char buffer[MAX_PATH];
    if (SearchPathA(NULL, "adb.exe", NULL, MAX_PATH, buffer, NULL) > 0) {
        m_adbPath = buffer;
        return true;
    }
    return false;
}

std::string AdbManager::ExecuteCommand(const std::string& cmd) {
    if (m_adbPath.empty()) return "";

    std::string fullCmd = "\"" + m_adbPath + "\" " + cmd;
    std::string result;

    HANDLE hStdOutPipeRead = NULL;
    HANDLE hStdOutPipeWrite = NULL;

    SECURITY_ATTRIBUTES sa = { sizeof(SECURITY_ATTRIBUTES), NULL, TRUE };
    if (!CreatePipe(&hStdOutPipeRead, &hStdOutPipeWrite, &sa, 0)) return "";
    SetHandleInformation(hStdOutPipeRead, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOA si = { sizeof(STARTUPINFOA) };
    si.dwFlags |= STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.hStdOutput = hStdOutPipeWrite;
    si.hStdError = hStdOutPipeWrite;
    si.wShowWindow = SW_HIDE;

    PROCESS_INFORMATION pi = { 0 };
    std::vector<char> cmdVec(fullCmd.begin(), fullCmd.end());
    cmdVec.push_back(0);

    if (CreateProcessA(NULL, cmdVec.data(), NULL, NULL, TRUE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
        CloseHandle(hStdOutPipeWrite);
        hStdOutPipeWrite = NULL;

        char buf[1024];
        DWORD bytesRead = 0;
        while (ReadFile(hStdOutPipeRead, buf, sizeof(buf) - 1, &bytesRead, NULL) && bytesRead > 0) {
            buf[bytesRead] = 0;
            result += buf;
        }

        WaitForSingleObject(pi.hProcess, 3000);
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
    } else {
        CloseHandle(hStdOutPipeWrite);
    }

    CloseHandle(hStdOutPipeRead);
    return result;
}

std::vector<AdbDevice> AdbManager::GetDevices() {
    std::vector<AdbDevice> devices;
    std::string output = ExecuteCommand("devices -l");
    std::istringstream stream(output);
    std::string line;

    while (std::getline(stream, line)) {
        if (line.empty() || line.find("List of devices attached") != std::string::npos) continue;

        std::istringstream lineStream(line);
        std::string serial, state;
        lineStream >> serial >> state;

        if (state == "device") {
            AdbDevice dev;
            dev.serial = serial;
            std::string token;
            while (lineStream >> token) {
                if (token.rfind("model:", 0) == 0) {
                    dev.model = token.substr(6);
                } else if (token.rfind("product:", 0) == 0) {
                    dev.product = token.substr(8);
                }
            }
            if (dev.model.find("X810") != std::string::npos || 
                dev.product.find("gts9") != std::string::npos ||
                dev.model.find("Tab") != std::string::npos) {
                dev.is_tablet = true;
            }
            devices.push_back(dev);
        }
    }
    return devices;
}

bool AdbManager::SetupPortForward(const std::string& serial, int hostPort, int devicePort) {
    std::string cmd = "-s " + serial + " forward tcp:" + std::to_string(hostPort) + " tcp:" + std::to_string(devicePort);
    std::string out = ExecuteCommand(cmd);
    return true;
}

bool AdbManager::LaunchClientApp(const std::string& serial) {
    WakeDevice(serial);
    std::string cmd = "-s " + serial + " shell am start -n com.redisplay.client/.MainActivity";
    ExecuteCommand(cmd);
    return true;
}

bool AdbManager::WakeDevice(const std::string& serial) {
    std::string cmd = "-s " + serial + " shell input keyevent KEYCODE_WAKEUP";
    ExecuteCommand(cmd);
    return true;
}

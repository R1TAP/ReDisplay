#include "adb.h"
#include <windows.h>
#include <charconv>
#include <cstdint>
#include <iostream>
#include <sstream>

AdbManager::AdbManager() {
    FindAdbPath();
}

bool AdbManager::FindAdbPath() {
    wchar_t buffer[32768];
    const DWORD length = GetEnvironmentVariableW(L"REDISPLAY_ADB", buffer, _countof(buffer));
    if (length > 0) {
        if (length >= _countof(buffer) || GetFileAttributesW(buffer) == INVALID_FILE_ATTRIBUTES) return false;
        m_adbPath = buffer;
        return true;
    }

    const wchar_t* candidates[] = {
        L"adb.exe",
        L"resources\\bin\\adb.exe",
        L"..\\resources\\bin\\adb.exe",
        L"..\\Release\\ReDisplay-Win64\\resources\\bin\\adb.exe",
        L"bin\\adb.exe",
        L"..\\bin\\adb.exe",
        L"C:\\Program Files\\QtScrcpy-win-x64-v3.2.0\\adb.exe"
    };
    for (const auto* candidate : candidates) {
        if (GetFileAttributesW(candidate) != INVALID_FILE_ATTRIBUTES) {
            const DWORD size = GetFullPathNameW(candidate, _countof(buffer), buffer, nullptr);
            if (size > 0 && size < _countof(buffer)) {
                m_adbPath = buffer;
                return true;
            }
        }
    }
    const DWORD size = SearchPathW(nullptr, L"adb.exe", nullptr, _countof(buffer), buffer, nullptr);
    if (size > 0 && size < _countof(buffer)) {
        m_adbPath = buffer;
        return true;
    }
    return false;
}

bool AdbManager::ExecuteCommand(const std::string& cmd, std::string& output) {
    if (m_adbPath.empty()) return false;

    const std::wstring command = L"\"" + m_adbPath + L"\" " + std::wstring(cmd.begin(), cmd.end());
    std::wstring writableCommand = command;
    SECURITY_ATTRIBUTES attributes{ sizeof(attributes), nullptr, TRUE };
    HANDLE readPipe = nullptr;
    HANDLE writePipe = nullptr;
    if (!CreatePipe(&readPipe, &writePipe, &attributes, 0)) return false;
    SetHandleInformation(readPipe, HANDLE_FLAG_INHERIT, 0);

    HANDLE input = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                               &attributes, OPEN_EXISTING, 0, nullptr);
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = input;
    startup.StartupInfo.hStdOutput = writePipe;
    startup.StartupInfo.hStdError = writePipe;

    SIZE_T attributeBytes = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeBytes);
    std::vector<uint8_t> attributeStorage(attributeBytes);
    startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeStorage.data());
    PROCESS_INFORMATION process{};
    BOOL started = FALSE;
    if (input != INVALID_HANDLE_VALUE && InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attributeBytes)) {
        // The ADB server must never inherit Electron's Host stdout or stdin pipe.
        HANDLE inherited[]{ input, writePipe };
        if (UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                      inherited, sizeof(inherited), nullptr, nullptr)) {
            started = CreateProcessW(m_adbPath.c_str(), writableCommand.data(), nullptr, nullptr, TRUE,
                                     CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr,
                                     &startup.StartupInfo, &process);
        }
        DeleteProcThreadAttributeList(startup.lpAttributeList);
    }
    CloseHandle(writePipe);
    if (input != INVALID_HANDLE_VALUE) CloseHandle(input);
    if (!started) {
        CloseHandle(readPipe);
        return false;
    }

    CloseHandle(process.hThread);
    const ULONGLONG deadline = GetTickCount64() + 5000;
    bool timedOut = false;
    for (;;) {
        DWORD available = 0;
        if (PeekNamedPipe(readPipe, nullptr, 0, nullptr, &available, nullptr) && available > 0) {
            char buffer[4096];
            DWORD received = 0;
            if (!ReadFile(readPipe, buffer, (std::min)(available, static_cast<DWORD>(sizeof(buffer))), &received, nullptr)) break;
            output.append(buffer, received);
        } else if (WaitForSingleObject(process.hProcess, 10) == WAIT_OBJECT_0) {
            // A child may have written to the pipe just before it exited.
            if (!PeekNamedPipe(readPipe, nullptr, 0, nullptr, &available, nullptr) || available == 0) break;
        }
        if (GetTickCount64() >= deadline || output.size() > 1024 * 1024) {
            timedOut = true;
            break;
        }
    }

    DWORD exitCode = 1;
    if (timedOut || WaitForSingleObject(process.hProcess, 100) != WAIT_OBJECT_0) {
        TerminateProcess(process.hProcess, 1);
        std::cerr << "[ADB] Command timed out or exceeded the output limit\n";
    } else {
        GetExitCodeProcess(process.hProcess, &exitCode);
    }
    CloseHandle(readPipe);
    CloseHandle(process.hProcess);
    return exitCode == 0;
}

std::vector<AdbDevice> AdbManager::GetDevices() {
    std::vector<AdbDevice> devices;
    std::string output;
    if (!ExecuteCommand("devices -l", output)) return devices;
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


static bool IsValidSerial(const std::string& serial) {
    return !serial.empty() &&
           serial.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:-[]%") == std::string::npos;
}

int AdbManager::SetupPortForward(const std::string& serial, int hostPort, int devicePort) {
    std::string output;
    if (!IsValidSerial(serial) ||
        !ExecuteCommand("-s " + serial + " forward --no-rebind tcp:" + std::to_string(hostPort) +
                        " tcp:" + std::to_string(devicePort), output)) {
        std::cerr << "[ADB] Forward failed: " << output << '\n';
        return 0;
    }
    if (hostPort != 0) return hostPort;
    std::istringstream lines(output);
    std::string line;
    while (std::getline(lines, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        int assignedPort = 0;
        auto [end, error] = std::from_chars(line.data(), line.data() + line.size(), assignedPort);
        if (error == std::errc{} && end == line.data() + line.size() &&
            assignedPort > 0 && assignedPort <= 65535) return assignedPort;
    }
    std::cerr << "[ADB] Forward did not report the allocated port: " << output << '\n';
    return 0;
}

void AdbManager::RemovePortForward(const std::string& serial, int hostPort) {
    std::string output;
    ExecuteCommand("-s " + serial + " forward --remove tcp:" + std::to_string(hostPort), output);
}

bool AdbManager::LaunchClientApp(const std::string& serial) {
    if (!IsValidSerial(serial)) return false;
    const std::string prefix = "-s " + serial + " shell ";
    std::string output;
    ExecuteCommand(prefix + "input keyevent KEYCODE_WAKEUP", output);
    output.clear();
    if (ExecuteCommand(prefix + "am start -W -n com.redisplay.client.v120demo/com.redisplay.client.MainActivity", output) &&
        output.find("Status: ok") != std::string::npos) return true;
    std::cerr << "[ADB] Android launch failed: " << output << '\n';
    return false;
}

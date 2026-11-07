#pragma once
#include <string>
#include <vector>

struct AdbDevice {
    std::string serial;
    std::string model;
    std::string product;
    bool is_tablet = false;
};

class AdbManager {
public:
    AdbManager();

    bool FindAdbPath();
    std::wstring GetAdbPath() const { return m_adbPath; }

    std::vector<AdbDevice> GetDevices();
    int SetupPortForward(const std::string& serial, int hostPort, int devicePort);
    void RemovePortForward(const std::string& serial, int hostPort);
    bool LaunchClientApp(const std::string& serial);

private:
    std::wstring m_adbPath;
    bool ExecuteCommand(const std::string& cmd, std::string& output);
};

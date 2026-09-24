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
    std::string GetAdbPath() const { return m_adbPath; }

    std::vector<AdbDevice> GetDevices();
    bool SetupPortForward(const std::string& serial, int hostPort, int devicePort);
    bool LaunchClientApp(const std::string& serial);
    bool WakeDevice(const std::string& serial);

private:
    std::string m_adbPath;
    std::string ExecuteCommand(const std::string& cmd);
};

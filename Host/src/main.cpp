#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <timeapi.h>
#include <dxgi.h>
#include <algorithm>
#include <array>
#include <charconv>
#include <chrono>
#include <iostream>
#include <set>
#include <tuple>
#include <iomanip>
#include <string_view>
#include <thread>

#include <winrt/Windows.Foundation.h>

#include "adb.h"
#include "display_manager.h"
#include "encoder.h"
#include "capture.h"
#include "transport.h"

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "winmm.lib")

using namespace std::chrono;
using namespace std::chrono_literals;

static std::atomic<bool> g_running{ true };

static BOOL WINAPI ConsoleHandler(DWORD signal) {
    if (signal != CTRL_C_EVENT && signal != CTRL_CLOSE_EVENT) return FALSE;
    g_running = false;
    return TRUE;
}

static uint64_t GetTimestampUs() {
    return duration_cast<microseconds>(steady_clock::now().time_since_epoch()).count();
}

static std::string WStringToUtf8(const std::wstring& wstr) {
    if (wstr.empty()) return "";
    int sz = WideCharToMultiByte(CP_UTF8, 0, wstr.data(), (int)wstr.size(), NULL, 0, NULL, NULL);
    std::string str(sz, 0);
    WideCharToMultiByte(CP_UTF8, 0, wstr.data(), (int)wstr.size(), &str[0], sz, NULL, NULL);
    return str;
}

static std::string EscapeJson(const std::string& input) {
    std::string output;
    for (char c : input) {
        if (c == '\\') output += "\\\\";
        else if (c == '"') output += "\\\"";
        else if (c == '\n') output += "\\n";
        else if (c == '\r') output += "\\r";
        else if (c == '\t') output += "\\t";
        else if (static_cast<unsigned char>(c) < 32) {
            constexpr char hex[] = "0123456789abcdef";
            output += "\\u00";
            output += hex[static_cast<unsigned char>(c) >> 4];
            output += hex[c & 0xf];
        } else output += c;
    }
    return output;
}


static void ReportState(bool gui, std::string_view status, const std::string& message) {
    if (gui) {
        std::cout << "{\"type\":\"state\",\"status\":\"" << status
                  << "\",\"message\":\"" << EscapeJson(message) << "\"}" << std::endl;
    } else {
        std::cout << '[' << status << "] " << message << std::endl;
    }
}

static std::set<std::tuple<DWORD, DWORD, DWORD>> GetVirtualModes(const DisplayInfo& display) {
    std::set<std::tuple<DWORD, DWORD, DWORD>> modes;
    if (display.isVirtual) {
        for (DWORD index = 0; ; ++index) {
            DEVMODEW mode{};
            mode.dmSize = sizeof(mode);
            if (!EnumDisplaySettingsW(display.deviceName.c_str(), index, &mode)) break;
            if (mode.dmBitsPerPel >= 32 && mode.dmDisplayFrequency > 1 && mode.dmDisplayFrequency <= 240) {
                modes.emplace(mode.dmPelsWidth, mode.dmPelsHeight, mode.dmDisplayFrequency);
            }
        }
    }

    return modes;
}

static void PrintVirtualModes(const DisplayInfo& display) {
    const auto modes = GetVirtualModes(display);
    std::cout << ",\"modes\":[";
    bool first = true;
    for (const auto& [width, height, fps] : modes) {
        if (!first) std::cout << ',';
        first = false;
        std::cout << "{\"width\":" << width << ",\"height\":" << height << ",\"fps\":" << fps << '}';
    }
    std::cout << ']';
}

static void PrintDisplays() {
    const auto displays = DisplayManager::EnumerateDisplays();
    std::cout << "{\"type\":\"displays\",\"displays\":[";
    for (size_t i = 0; i < displays.size(); ++i) {
        const auto& display = displays[i];
        if (i) std::cout << ',';
        std::cout << "{\"index\":" << display.index
                  << ",\"name\":\"" << EscapeJson(WStringToUtf8(display.deviceName)) << "\""
                  << ",\"adapter\":\"" << EscapeJson(WStringToUtf8(display.adapterName)) << "\""
                  << ",\"width\":" << display.width
                  << ",\"height\":" << display.height
                  << ",\"fps\":" << display.fps
                  << ",\"isPrimary\":" << (display.isPrimary ? "true" : "false")
                  << ",\"isVirtual\":" << (display.isVirtual ? "true" : "false");
        PrintVirtualModes(display);
        std::cout << '}';
    }
    std::cout << "]}" << std::endl;
}

static void PrintDevices() {
    AdbManager adb;
    const auto devices = adb.GetDevices();
    std::cout << "{\"type\":\"devices\",\"devices\":[";
    for (size_t i = 0; i < devices.size(); ++i) {
        const auto& device = devices[i];
        if (i) std::cout << ',';
        std::cout << "{\"serial\":\"" << EscapeJson(device.serial)
                  << "\",\"model\":\"" << EscapeJson(device.model)
                  << "\",\"product\":\"" << EscapeJson(device.product)
                  << "\",\"is_tablet\":" << (device.is_tablet ? "true" : "false") << '}';
    }
    std::cout << "]}" << std::endl;
}

struct Settings {
    int width = 1752;
    int height = 2800;
    int fps = 180;
    int bitrate = 60;
    int port = 0;
    int display = -1;
    std::string displayName;
    std::string serial;
    std::string bufferMode = "lowlatency";
    bool gui = false;
    bool reconnect = true;
};

static bool ReadInteger(std::string_view value, int& result) {
    if (value.empty()) return false;
    const auto [end, error] = std::from_chars(value.data(), value.data() + value.size(), result);
    return error == std::errc{} && end == value.data() + value.size();
}

static bool LoadSettings(int argc, char* argv[], Settings& config) {
    wchar_t iniPath[32768];
    DWORD pathSize = GetFullPathNameW(L"config.ini", _countof(iniPath), iniPath, nullptr);
    if (pathSize > 0 && pathSize < _countof(iniPath)) {
        config.display = static_cast<int>(GetPrivateProfileIntW(L"Display", L"display_index", config.display, iniPath));
        config.width = GetPrivateProfileIntW(L"Display", L"width", config.width, iniPath);
        config.height = GetPrivateProfileIntW(L"Display", L"height", config.height, iniPath);
        config.fps = GetPrivateProfileIntW(L"Display", L"fps", config.fps, iniPath);
        config.bitrate = GetPrivateProfileIntW(L"Encoder", L"bitrate_mbps", config.bitrate, iniPath);
        config.port = GetPrivateProfileIntW(L"Device", L"port", config.port, iniPath);
        wchar_t serial[256]{};
        GetPrivateProfileStringW(L"Device", L"serial", L"auto", serial, _countof(serial), iniPath);
        config.serial = WStringToUtf8(serial);
    }

    for (int i = 1; i < argc; ++i) {
        const std::string_view arg = argv[i];
        if (arg == "--gui") continue;
        if (arg == "--no-reconnect") { config.reconnect = false; continue; }
        if (i <= 3 && !arg.starts_with("--")) {
            int& field = (i == 1) ? config.display : (i == 2) ? config.fps : config.bitrate;
            if (!ReadInteger(arg, field)) return false;
            continue;
        }
        if (++i >= argc) return false;
        const std::string_view value = argv[i];
        if (arg == "--serial") config.serial = value;
        else if (arg == "--display-name") config.displayName = value;
        else if (arg == "--buffer-mode") config.bufferMode = value;
        else {
            int* field = nullptr;
            if (arg == "--display") field = &config.display;
            else if (arg == "--width") field = &config.width;
            else if (arg == "--height") field = &config.height;
            else if (arg == "--fps") field = &config.fps;
            else if (arg == "--bitrate") field = &config.bitrate;
            else if (arg == "--port") field = &config.port;
            if (!field || !ReadInteger(value, *field)) return false;
        }
    }
    if (config.serial == "auto") config.serial.clear();
    return config.display >= -1 && config.width > 0 && config.width <= 8192 &&
           config.height > 0 && config.height <= 8192 && config.fps >= 0 && config.fps <= 240 &&
           config.bitrate > 0 && config.bitrate <= 300 && config.port >= 0 && config.port <= 65535 &&
           (config.bufferMode == "smooth" || config.bufferMode == "lowlatency");
}

static DisplayInfo ConfigureDisplay(const Settings& config) {
    DisplayInfo display{};
    if (config.displayName.empty()) {
        display = DisplayManager::PickTargetDisplay(config.display, config.width, config.height);
    } else {
        for (const auto& candidate : DisplayManager::EnumerateDisplays()) {
            if (WStringToUtf8(candidate.deviceName) == config.displayName) {
                display = candidate;
                break;
            }
        }
    }
    if (!display.hMonitor || !display.isVirtual) return display;

    const int requested = config.fps > 0 ? config.fps : display.fps;
    int modeFps = 0;
    int firstModeFps = 0;
    for (const auto& [width, height, rate] : GetVirtualModes(display)) {
        if (width != static_cast<DWORD>(config.width) || height != static_cast<DWORD>(config.height)) continue;
        if (!firstModeFps) firstModeFps = rate;
        if (rate <= static_cast<DWORD>(requested)) modeFps = rate;
    }
    if (!modeFps) modeFps = firstModeFps;
    if (!modeFps) {
        ReportState(config.gui, "mode_warning", "The requested resolution is unavailable. Using the current Windows mode.");
        return display;
    }
    if (modeFps == display.fps && config.width == display.width && config.height == display.height) return display;

    DEVMODEW mode{};
    mode.dmSize = sizeof(mode);
    if (!EnumDisplaySettingsW(display.deviceName.c_str(), ENUM_CURRENT_SETTINGS, &mode)) return display;
    mode.dmPelsWidth = config.width;
    mode.dmPelsHeight = config.height;
    mode.dmDisplayFrequency = modeFps;
    mode.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY;
    const LONG result = ChangeDisplaySettingsExW(display.deviceName.c_str(), &mode, nullptr, CDS_UPDATEREGISTRY, nullptr);
    if (result != DISP_CHANGE_SUCCESSFUL) {
        ReportState(config.gui, "mode_warning", "Display mode change rejected (" + std::to_string(result) +
                    "). Streaming with current Windows mode.");
        return display;
    }
    for (const auto& updated : DisplayManager::EnumerateDisplays()) {
        if (updated.deviceName == display.deviceName) return updated;
    }
    return {};
}

static winrt::com_ptr<ID3D11Device> CreateEncodeDevice() {
    winrt::com_ptr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(factory.put())))) return {};
    for (UINT i = 0; ; ++i) {
        winrt::com_ptr<IDXGIAdapter1> adapter;
        if (FAILED(factory->EnumAdapters1(i, adapter.put()))) break;
        DXGI_ADAPTER_DESC1 desc{};
        if (FAILED(adapter->GetDesc1(&desc)) || desc.VendorId != 0x10de || (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE)) {
            continue;
        }
        winrt::com_ptr<ID3D11Device> device;
        if (SUCCEEDED(D3D11CreateDevice(adapter.get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                                       nullptr, 0, D3D11_SDK_VERSION, device.put(), nullptr, nullptr))) return device;
    }
    return {};
}

struct ForwardedPort {
    AdbManager& adb;
    const std::string& serial;
    int port;
    ~ForwardedPort() { if (port) adb.RemovePortForward(serial, port); }
};

struct StreamSocket {
    SOCKET value = INVALID_SOCKET;
    ~StreamSocket() { if (value != INVALID_SOCKET) closesocket(value); }
};

static SOCKET ConnectToClient(int port) {
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(static_cast<u_short>(port));
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    for (int attempt = 0; g_running && attempt < 15; ++attempt) {
        StreamSocket sock{ socket(AF_INET, SOCK_STREAM, IPPROTO_TCP) };
        if (sock.value == INVALID_SOCKET) return INVALID_SOCKET;

        int enabled = 1;
        int sendTimeoutMs = 500;
        // Bound queued TCP data on the Host side. The ADB tunnel also buffers independently.
        int sendBuffer = 256 * 1024;
        setsockopt(sock.value, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&enabled), sizeof(enabled));
        setsockopt(sock.value, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&sendTimeoutMs), sizeof(sendTimeoutMs));
        setsockopt(sock.value, SOL_SOCKET, SO_SNDBUF, reinterpret_cast<const char*>(&sendBuffer), sizeof(sendBuffer));
        if (connect(sock.value, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) == 0) {
            return std::exchange(sock.value, INVALID_SOCKET);
        }
        std::this_thread::sleep_for(200ms);
    }
    return INVALID_SOCKET;
}

static uint64_t ToNetwork64(uint64_t value) {
    return (static_cast<uint64_t>(htonl(static_cast<uint32_t>(value))) << 32) |
           htonl(static_cast<uint32_t>(value >> 32));
}

class ClientControl {
public:
    bool Poll(SOCKET socket) {
        fd_set readable;
        FD_ZERO(&readable);
        FD_SET(socket, &readable);
        timeval timeout{ 0, 100000 };
        const int readableCount = select(0, &readable, nullptr, nullptr, &timeout);
        if (readableCount <= 0) return readableCount == 0;

        const int received = recv(socket, reinterpret_cast<char*>(&m_packet) + m_read,
                                  sizeof(m_packet) - m_read, 0);
        if (received <= 0) return false;
        m_read += received;
        if (m_read < sizeof(m_packet)) return true;
        m_read = 0;
        if (m_packet.magic != htonl(REDISPLAY_MAGIC) || m_packet.payload_size != 0) return false;
        if (m_packet.packet_type == PACKET_TYPE_READY && !ready) {
            ready = true;
        } else if (m_packet.packet_type == PACKET_TYPE_REQUEST_IDR && ready) {
            requestIdr = true;
        } else {
            return false;
        }
        return true;
    }

    bool WaitForReady(SOCKET socket) {
        const auto deadline = steady_clock::now() + 2500ms;
        while (g_running && !ready && steady_clock::now() < deadline) {
            if (!Poll(socket)) return false;
        }
        return ready && g_running;
    }

    std::atomic<bool> requestIdr{ false };

private:
    bool ready = false;
    PacketHeader m_packet{};
    unsigned m_read = 0;
};

struct EncodeStats {
    uint64_t frames = 0;
    uint64_t microseconds = 0;
    std::array<uint64_t, 256> durations{};
    std::array<uint64_t, 256> intervals{};
};

static double P95Ms(std::array<uint64_t, 256>& samples, uint64_t frames) {
    const auto count = std::min<uint64_t>(frames, samples.size());
    if (!count) return 0.0;
    const auto index = (count * 95 - 1) / 100;
    std::nth_element(samples.begin(), samples.begin() + index, samples.begin() + count);
    return samples[index] / 1000.0;
}

static void Stream(AdbManager& adb, const AdbDevice& android, const Settings& config) {
    if (config.gui) {
        std::cout << "{\"type\":\"device_selected\",\"serial\":\"" << EscapeJson(android.serial)
                  << "\",\"model\":\"" << EscapeJson(android.model) << "\"}" << std::endl;
    }
    ReportState(config.gui, "connecting", "Opening an ADB tunnel");
    const ForwardedPort forward{ adb, android.serial, adb.SetupPortForward(android.serial, config.port, CLIENT_PORT) };
    if (!forward.port) {
        ReportState(config.gui, "error", "ADB port forward failed");
        return;
    }
    if (!g_running) return;
    ReportState(config.gui, "launching_app", "Launching ReDisplay Demo on " + android.model);
    if (!adb.LaunchClientApp(android.serial) || !g_running) {
        ReportState(config.gui, "error", "ReDisplay Demo could not start on Android");
        return;
    }

    const auto display = ConfigureDisplay(config);
    if (!display.hMonitor) {
        ReportState(config.gui, "error", "The selected display is unavailable");
        return;
    }
    const int requestedFps = config.fps > 0 ? config.fps : display.fps;
    // WGC can deliver at the compositor cadence even when an existing VDD advertises a lower mode.
    const int fps = display.isVirtual ? requestedFps : std::min(requestedFps, display.fps);
    auto device = CreateEncodeDevice();
    if (!device) {
        ReportState(config.gui, "error", "Could not create a D3D11 device on an NVIDIA adapter");
        return;
    }

    StreamSocket sock{ ConnectToClient(forward.port) };
    if (sock.value == INVALID_SOCKET) {
        ReportState(config.gui, "error", "Could not connect to the Android Demo");
        return;
    }

    NvEncoderD3D11 encoder;
    AsyncNetworkSender sender(sock.value, config.bufferMode == "smooth" ? 12 : 2);
    std::mutex statsMutex;
    EncodeStats encodeStats;
    uint64_t previousEncodeStart = 0;
    ClientControl control;
    bool needIdr = true;
    unsigned consecutiveEncodeFailures = 0;
    std::atomic<bool> encodeHealthy{ true };
    ScreenCapture capture;
    if (!capture.Initialize(device.get(), display.hMonitor, fps, [&](ID3D11Texture2D* texture, int, int) {
        if (!sender.alive || !g_running || !encodeHealthy) return;
        const uint64_t start = GetTimestampUs();
        EncodedPacket packet;
        packet.payload = sender.TakePayloadBuffer();
        bool keyframe = false;
        if (control.requestIdr.exchange(false)) needIdr = true;
        if (!encoder.EncodeFrame(texture, needIdr, packet.payload, keyframe) ||
            packet.payload.empty() || packet.payload.size() > MAX_VIDEO_BYTES) {
            needIdr = true;
            if (++consecutiveEncodeFailures >= 8) encodeHealthy = false;
            return;
        }
        consecutiveEncodeFailures = 0;
        {
            std::lock_guard lock(statsMutex);
            const uint64_t duration = GetTimestampUs() - start;
            const size_t index = encodeStats.frames++ % encodeStats.durations.size();
            encodeStats.durations[index] = duration;
            encodeStats.intervals[index] = previousEncodeStart ? start - previousEncodeStart : 0;
            previousEncodeStart = start;
            encodeStats.microseconds += duration;
        }
        if (needIdr && !keyframe) return;
        packet.header.magic = htonl(REDISPLAY_MAGIC);
        packet.header.packet_type = PACKET_TYPE_VIDEO;
        packet.header.flags = keyframe ? FLAG_KEYFRAME : FLAG_NONE;
        packet.header.timestamp_us = ToNetwork64(start);
        packet.header.payload_size = htonl(static_cast<uint32_t>(packet.payload.size()));
        needIdr = !sender.Push(std::move(packet));
    })) {
        ReportState(config.gui, "error", "Screen capture initialization failed");
        return;
    }

    const int width = capture.GetWidth();
    const int height = capture.GetHeight();
    if (!encoder.Initialize(device.get(), width, height, fps, config.bitrate)) {
        ReportState(config.gui, "error", "NVENC encoder initialization failed");
        return;
    }
    const PacketHeader header{ htonl(REDISPLAY_MAGIC), PACKET_TYPE_CONFIG, 0, 0, 0, htonl(sizeof(ConfigPayload)) };
    const ConfigPayload payload{ htonl(width), htonl(height), htonl(fps) };
    if (!SendPacket(sock.value, header, &payload, sizeof(payload)) || !control.WaitForReady(sock.value)) {
        if (g_running) ReportState(config.gui, "error", "Android decoder did not become ready");
        return;
    }
    sender.Start();
    if (!capture.Start()) {
        ReportState(config.gui, "error", "Screen capture could not start");
        return;
    }

    if (config.gui) {
        std::cout << "{\"type\":\"state\",\"status\":\"streaming\",\"display\":" << display.index
                  << ",\"width\":" << width << ",\"height\":" << height << ",\"fps\":" << fps
                  << ",\"displayHz\":" << display.fps << ",\"bitrate\":" << config.bitrate << ",\"device\":\"" << EscapeJson(android.model)
                  << "\"}" << std::endl;
    } else {
        std::cout << "[Streaming] " << width << 'x' << height << " @" << fps << " Hz" << std::endl;
    }

    auto lastTime = steady_clock::now();
    uint64_t lastSent = 0, lastBytes = 0, lastArrived = 0;
    while (g_running && sender.alive && capture.IsHealthy() && encodeHealthy && control.Poll(sock.value)) {
        const auto now = steady_clock::now();
        if (now - lastTime < 500ms) continue;

        const double elapsed = duration<double>(now - lastTime).count();
        const auto sent = sender.frames.load();
        const auto bytes = sender.bytes.load();
        const auto arrived = capture.GetArrivedFrameCount();
        EncodeStats encoded;
        {
            std::lock_guard lock(statsMutex);
            encoded = std::exchange(encodeStats, {});
        }
        const double sentFps = (sent - lastSent) / elapsed;
        const double wgcFps = (arrived - lastArrived) / elapsed;
        const double encodeFps = encoded.frames / elapsed;
        const double mbps = (bytes - lastBytes) * 8.0 / (elapsed * 1000000.0);
        const double encodeMs = encoded.frames ? encoded.microseconds / (1000.0 * encoded.frames) : 0.0;
        const auto dropped = sender.dropped.load();

        if (config.gui) {
            std::cout << std::fixed << std::setprecision(1) << "{\"type\":\"stats\",\"fps\":" << sentFps
                      << ",\"wgcFps\":" << wgcFps << ",\"encodeFps\":" << encodeFps << ",\"mbps\":" << mbps
                      << std::setprecision(2) << ",\"encodeMs\":" << encodeMs
                      << ",\"encodeP95Ms\":" << P95Ms(encoded.durations, encoded.frames)
                      << ",\"encodeGapP95Ms\":" << P95Ms(encoded.intervals, encoded.frames)
                      << ",\"frames\":" << sent
                      << ",\"dropped\":" << dropped << ",\"bytes\":" << bytes
                      << ",\"device\":\"" << EscapeJson(android.model) << "\"}" << std::endl;
        } else {
            std::cout << std::fixed << std::setprecision(1) << "\rWGC " << wgcFps << " FPS | NVENC " << encodeFps
                      << " FPS (" << std::setprecision(2) << encodeMs << " ms) | TCP " << sentFps << " FPS ("
                      << mbps << " Mbps) | Drop " << dropped << "    " << std::flush;
        }
        lastTime = now;
        lastSent = sent;
        lastBytes = bytes;
        lastArrived = arrived;
    }
    capture.Stop();
    sender.Stop();
    if (!encodeHealthy) ReportState(config.gui, "error", "NVENC stopped producing valid frames");
    if (g_running) ReportState(config.gui, "disconnected", "Stream closed. Waiting to reconnect");
}

int main(int argc, char* argv[]) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    Settings config;
    for (int i = 1; i < argc; ++i) {
        const std::string_view arg = argv[i];
        if (arg == "--list-displays") { PrintDisplays(); return 0; }
        if (arg == "--list-devices") { PrintDevices(); return 0; }
        if (arg == "--driver-status") {
            std::cout << (DisplayManager::IsVddDriverInstalled() ? "true" : "false") << std::endl;
            return 0;
        }
        if (arg == "--version") { std::cout << "ReDisplay Host 1.1.0\n"; return 0; }
        if (arg == "--gui") config.gui = true;
    }
    if (!LoadSettings(argc, argv, config)) {
        ReportState(config.gui, "error", "Invalid command-line or INI settings");
        return 2;
    }

    AdbManager adb;
    if (adb.GetAdbPath().empty()) {
        ReportState(config.gui, "error", "ADB not found");
        return 1;
    }

    WSADATA wsa{};
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        ReportState(config.gui, "error", "Winsock initialization failed");
        return 1;
    }
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    SetConsoleCtrlHandler(ConsoleHandler, TRUE);
    if (config.gui && GetFileType(GetStdHandle(STD_INPUT_HANDLE)) == FILE_TYPE_PIPE) {
        std::thread([] {
            // Electron closes the pipe when it stops the Host or exits.
            std::cin.get();
            g_running = false;
        }).detach();
    }

    while (g_running) {
        auto devices = adb.GetDevices();
        if (!g_running) break;
        const auto selected = config.serial.empty()
            ? std::find_if(devices.begin(), devices.end(), [](const auto& d) { return d.is_tablet; })
            : std::find_if(devices.begin(), devices.end(), [&](const auto& d) { return d.serial == config.serial; });
        if (selected != devices.end()) {
            Stream(adb, *selected, config);
        } else if (config.serial.empty() && !devices.empty()) {
            Stream(adb, devices.front(), config);
        } else {
            ReportState(config.gui, "waiting_device", config.serial.empty() ?
                        "Waiting for an authorized Android device" : "Waiting for the selected Android device");
        }
        if (!config.reconnect) break;
        for (int i = 0; i < 10 && g_running; ++i) std::this_thread::sleep_for(100ms);
    }

    winrt::uninit_apartment();
    WSACleanup();
    ReportState(config.gui, "stopped", "ReDisplay Host stopped");
    return 0;
}

#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <timeapi.h>
#include <iostream>
#include <chrono>
#include <thread>
#include <atomic>
#include <vector>
#include <deque>
#include <mutex>
#include <condition_variable>
#include <string>
#include <iomanip>

#include <winrt/Windows.Foundation.h>

#include "protocol.h"
#include "adb.h"
#include "display_manager.h"
#include "encoder.h"
#include "capture.h"

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "winmm.lib")

struct EncodedPacket {
    PacketHeader hdr;
    std::vector<uint8_t> bitstream;
    uint64_t frameIdx = 0;
};

class AsyncNetworkSender {
public:
    AsyncNetworkSender(SOCKET s, std::atomic<bool>& alive, std::atomic<uint64_t>& fc, std::atomic<uint64_t>& tb, std::atomic<uint64_t>& df, int maxQueueSize = 2)
        : m_sock(s), m_connectionAlive(alive), m_frameCount(fc), m_totalBytes(tb), m_droppedFrames(df), m_maxQueue(maxQueueSize) {}

    ~AsyncNetworkSender() { Stop(); }

    void Start() {
        m_running = true;
        m_thread = std::thread([this]() {
            SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);
            while (m_running && m_connectionAlive) {
                EncodedPacket pkt;
                {
                    std::unique_lock<std::mutex> lock(m_mutex);
                    m_cv.wait(lock, [this]() {
                        return !m_running || !m_queue.empty() || !m_connectionAlive;
                    });
                    if (!m_running || !m_connectionAlive) break;
                    if (m_queue.empty()) continue;

                    pkt = std::move(m_queue.front());
                    m_queue.pop_front();
                }

                int s1 = send(m_sock, (char*)&pkt.hdr, sizeof(pkt.hdr), 0);
                if (s1 <= 0) {
                    m_connectionAlive = false;
                    break;
                }
                int s2 = send(m_sock, (char*)pkt.bitstream.data(), (int)pkt.bitstream.size(), 0);
                if (s2 <= 0) {
                    m_connectionAlive = false;
                    break;
                }

                m_frameCount++;
                m_totalBytes += sizeof(pkt.hdr) + pkt.bitstream.size();
            }
        });
    }

    void Push(EncodedPacket&& pkt) {
        if (!m_connectionAlive || !m_running) return;
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            // Dynamic queue bound: drops non-keyframes when queue is full
            if ((int)m_queue.size() >= m_maxQueue) {
                if (!(m_queue.front().hdr.flags & FLAG_KEYFRAME)) {
                    m_queue.pop_front();
                    m_droppedFrames++;
                }
            }
            m_queue.push_back(std::move(pkt));
        }
        m_cv.notify_one();
    }

    void Stop() {
        m_running = false;
        m_cv.notify_all();
        if (m_thread.joinable()) {
            m_thread.join();
        }
    }

private:
    SOCKET m_sock;
    std::atomic<bool>& m_connectionAlive;
    std::atomic<uint64_t>& m_frameCount;
    std::atomic<uint64_t>& m_totalBytes;
    std::atomic<uint64_t>& m_droppedFrames;
    int m_maxQueue = 2;
    std::mutex m_mutex;
    std::condition_variable m_cv;
    std::deque<EncodedPacket> m_queue;
    std::atomic<bool> m_running{ false };
    std::thread m_thread;
};

static std::atomic<bool> g_running(true);

BOOL WINAPI ConsoleHandler(DWORD signal) {
    if (signal == CTRL_C_EVENT || signal == CTRL_CLOSE_EVENT) {
        g_running = false;
        return TRUE;
    }
    return FALSE;
}

uint64_t GetTimestampUs() {
    static LARGE_INTEGER freq;
    static BOOL init = QueryPerformanceFrequency(&freq);
    LARGE_INTEGER count;
    QueryPerformanceCounter(&count);
    return (uint64_t)(count.QuadPart * 1000000.0 / freq.QuadPart);
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
        else output += c;
    }
    return output;
}

int main(int argc, char* argv[]) {
    timeBeginPeriod(1);
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    SetConsoleCtrlHandler(ConsoleHandler, TRUE);
    winrt::init_apartment(winrt::apartment_type::multi_threaded);

    // Config defaults
    int targetWidth = 1752;
    int targetHeight = 2800;
    int targetFps = 120;
    int bitrateMbps = 60;
    int port = 27183;
    int prefDisplayIdx = -1;
    std::string prefSerial = "";
    std::string bufferMode = "lowlatency";
    bool isGui = false;

    // Check for helper commands first
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--list-displays") {
            auto displays = DisplayManager::EnumerateDisplays();
            std::cout << "{\"type\":\"displays\",\"displays\":[";
            for (size_t d = 0; d < displays.size(); ++d) {
                const auto& disp = displays[d];
                std::cout << "{\"index\":" << disp.index
                          << ",\"name\":\"" << EscapeJson(WStringToUtf8(disp.deviceName)) << "\""
                          << ",\"adapter\":\"" << EscapeJson(WStringToUtf8(disp.adapterName)) << "\""
                          << ",\"width\":" << disp.width
                          << ",\"height\":" << disp.height
                          << ",\"fps\":" << disp.fps
                          << ",\"isPrimary\":" << (disp.isPrimary ? "true" : "false")
                          << ",\"isVirtual\":" << (disp.isVirtual ? "true" : "false")
                          << "}" << (d + 1 < displays.size() ? "," : "");
            }
            std::cout << "]}" << std::endl;
            return 0;
        } else if (arg == "--list-devices") {
            AdbManager adb;
            auto devs = adb.GetDevices();
            std::cout << "{\"type\":\"devices\",\"devices\":[";
            for (size_t d = 0; d < devs.size(); ++d) {
                const auto& dev = devs[d];
                std::cout << "{\"serial\":\"" << EscapeJson(dev.serial) << "\""
                          << ",\"model\":\"" << EscapeJson(dev.model) << "\""
                          << ",\"product\":\"" << EscapeJson(dev.product) << "\""
                          << ",\"is_tablet\":" << (dev.is_tablet ? "true" : "false")
                          << "}" << (d + 1 < devs.size() ? "," : "");
            }
            std::cout << "]}" << std::endl;
            return 0;
        } else if (arg == "--gui") {
            isGui = true;
        } else if (arg == "--display" && i + 1 < argc) {
            prefDisplayIdx = atoi(argv[++i]);
        } else if (arg == "--fps" && i + 1 < argc) {
            targetFps = atoi(argv[++i]);
        } else if (arg == "--bitrate" && i + 1 < argc) {
            bitrateMbps = atoi(argv[++i]);
        } else if (arg == "--width" && i + 1 < argc) {
            targetWidth = atoi(argv[++i]);
        } else if (arg == "--height" && i + 1 < argc) {
            targetHeight = atoi(argv[++i]);
        } else if (arg == "--buffer-mode" && i + 1 < argc) {
            bufferMode = argv[++i];
        } else if (arg == "--serial" && i + 1 < argc) {
            prefSerial = argv[++i];
        } else if (arg == "--port" && i + 1 < argc) {
            port = atoi(argv[++i]);
        } else if (i == 1 && arg[0] != '-') {
            prefDisplayIdx = atoi(argv[1]);
        } else if (i == 2 && arg[0] != '-') {
            targetFps = atoi(argv[2]);
        } else if (i == 3 && arg[0] != '-') {
            bitrateMbps = atoi(argv[3]);
        }
    }

    // Load config.ini if present and not overridden
    char iniPath[MAX_PATH];
    GetFullPathNameA("config.ini", MAX_PATH, iniPath, NULL);
    if (GetFileAttributesA(iniPath) != INVALID_FILE_ATTRIBUTES) {
        if (prefDisplayIdx < 0) prefDisplayIdx = GetPrivateProfileIntA("Display", "display_index", -1, iniPath);
        targetWidth = GetPrivateProfileIntA("Display", "width", 1752, iniPath);
        targetHeight = GetPrivateProfileIntA("Display", "height", 2800, iniPath);
        if (targetFps == 120) targetFps = GetPrivateProfileIntA("Display", "fps", 120, iniPath);
        if (bitrateMbps == 60) bitrateMbps = GetPrivateProfileIntA("Encoder", "bitrate_mbps", 60, iniPath);
        if (port == 27183) port = GetPrivateProfileIntA("Device", "port", 27183, iniPath);
    }

    if (!isGui) {
        std::cout << "============================================================" << std::endl;
        std::cout << "  ReDisplay: Ultra-Low Latency Wired Secondary Display Host" << std::endl;
        std::cout << "  Target: Samsung Galaxy Tab S9+ (1752x2800 @ 120Hz)" << std::endl;
        std::cout << "============================================================" << std::endl;
    }

    // Initialize Winsock
    WSADATA wsaData;
    WSAStartup(MAKEWORD(2, 2), &wsaData);

    // 1. ADB Manager
    AdbManager adb;
    if (adb.GetAdbPath().empty()) {
        if (isGui) {
            std::cout << "{\"type\":\"state\",\"status\":\"error\",\"message\":\"ADB not found\"}" << std::endl;
        } else {
            std::cerr << "[ERROR] adb.exe not found! Please ensure ADB is installed." << std::endl;
        }
        return 1;
    }
    if (!isGui) {
        std::cout << "[ADB] Using ADB from: " << adb.GetAdbPath() << std::endl;
    }

    // Main reconnect loop
    while (g_running) {
        if (isGui) {
            std::cout << "{\"type\":\"state\",\"status\":\"detecting_devices\",\"message\":\"Scanning ADB devices...\"}" << std::endl;
        } else {
            std::cout << "\n[1/5] Detecting ADB devices..." << std::endl;
        }

        auto devices = adb.GetDevices();
        while (devices.empty() && g_running) {
            if (isGui) {
                std::cout << "{\"type\":\"state\",\"status\":\"waiting_device\",\"message\":\"Waiting for Android device connection...\"}" << std::endl;
            } else {
                std::cout << "\rWaiting for Android device to be connected via USB..." << std::flush;
            }
            std::this_thread::sleep_for(std::chrono::seconds(1));
            devices = adb.GetDevices();
        }
        if (!g_running) break;

        std::string chosenSerial;
        std::string chosenModel = "Unknown";

        // Check if preferred serial was requested
        if (!prefSerial.empty()) {
            for (const auto& d : devices) {
                if (d.serial == prefSerial) {
                    chosenSerial = d.serial;
                    chosenModel = d.model;
                    break;
                }
            }
        }

        // Fallback: tablet first, then first device
        if (chosenSerial.empty()) {
            for (const auto& d : devices) {
                if (!isGui) {
                    std::cout << "  Found device: " << d.serial << " (" << d.model << ", " << d.product << ")" 
                              << (d.is_tablet ? " [MATCHED TABLET]" : "") << std::endl;
                }
                if (d.is_tablet || chosenSerial.empty()) {
                    chosenSerial = d.serial;
                    chosenModel = d.model;
                }
            }
        }

        if (isGui) {
            std::cout << "{\"type\":\"device_selected\",\"serial\":\"" << chosenSerial 
                      << "\",\"model\":\"" << chosenModel << "\"}" << std::endl;
            std::cout << "{\"type\":\"state\",\"status\":\"connecting\",\"message\":\"Forwarding port " << port << "...\"}" << std::endl;
        } else {
            std::cout << "[2/5] Setting up port forward (tcp:" << port << " -> tcp:" << port << ")..." << std::endl;
        }

        adb.SetupPortForward(chosenSerial, port, port);

        if (isGui) {
            std::cout << "{\"type\":\"state\",\"status\":\"launching_app\",\"message\":\"Launching ReDisplay on " << chosenModel << "...\"}" << std::endl;
        } else {
            std::cout << "[3/5] Launching ReDisplay app on " << chosenModel << "..." << std::endl;
        }
        adb.LaunchClientApp(chosenSerial);
        std::this_thread::sleep_for(std::chrono::milliseconds(800));

        // Connect TCP
        if (!isGui) {
            std::cout << "[4/5] Connecting to tablet via ADB tunnel (127.0.0.1:" << port << ")..." << std::endl;
        }
        SOCKET sock = INVALID_SOCKET;
        int retries = 0;
        while (g_running && retries < 15) {
            sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
            int flag = 1;
            setsockopt(sock, IPPROTO_TCP, TCP_NODELAY, (char*)&flag, sizeof(flag));
            int sendBuf = 4 * 1024 * 1024;
            setsockopt(sock, SOL_SOCKET, SO_SNDBUF, (char*)&sendBuf, sizeof(sendBuf));

            sockaddr_in addr = { 0 };
            addr.sin_family = AF_INET;
            addr.sin_port = htons(port);
            inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);

            if (connect(sock, (sockaddr*)&addr, sizeof(addr)) == 0) {
                if (!isGui) {
                    std::cout << "  Connected successfully to tablet!" << std::endl;
                }
                break;
            }
            closesocket(sock);
            sock = INVALID_SOCKET;
            retries++;
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
        }

        if (sock == INVALID_SOCKET) {
            if (isGui) {
                std::cout << "{\"type\":\"state\",\"status\":\"error\",\"message\":\"Failed to connect to tablet app. Retrying...\"}" << std::endl;
            } else {
                std::cerr << "[ERROR] Could not connect to tablet app. Retrying in 2 seconds..." << std::endl;
            }
            std::this_thread::sleep_for(std::chrono::seconds(2));
            continue;
        }

        // Pick Display
        auto disp = DisplayManager::PickTargetDisplay(prefDisplayIdx, targetWidth, targetHeight);
        if (!isGui) {
            std::cout << "[5/5] Detecting Displays:" << std::endl;
            auto allDisplays = DisplayManager::EnumerateDisplays();
            for (const auto& d : allDisplays) {
                std::wcout << L"  - Display " << d.index << L": " << d.deviceName
                           << L" (" << d.adapterName << L") "
                           << d.width << L"x" << d.height << L" @" << d.fps << L"Hz"
                           << (d.isPrimary ? L" [Primary]" : L"") 
                           << (d.isVirtual ? L" [VIRTUAL DISPLAY!]" : L"")
                           << std::endl;
            }
            std::wcout << L"  >>> Active Capture -> Display " << disp.index 
                       << L" (" << disp.width << L"x" << disp.height << L" @" << disp.fps << L"Hz)"
                       << (disp.isPrimary ? L" [Primary]" : L"")
                       << (disp.isVirtual ? L" [VIRTUAL DISPLAY]" : L"") << L" <<<" << std::endl;
        }

        // Dynamically adjust virtual display resolution & refresh rate if requested
        if (disp.isVirtual && targetWidth > 0 && targetHeight > 0) {
            DEVMODEW dmMode = { sizeof(dmMode) };
            if (EnumDisplaySettingsW(disp.deviceName.c_str(), ENUM_CURRENT_SETTINGS, &dmMode)) {
                bool needChange = (dmMode.dmPelsWidth != (DWORD)targetWidth || dmMode.dmPelsHeight != (DWORD)targetHeight);
                if (targetFps > 0 && dmMode.dmDisplayFrequency != (DWORD)targetFps) {
                    needChange = true;
                }
                if (needChange) {
                    dmMode.dmPelsWidth = targetWidth;
                    dmMode.dmPelsHeight = targetHeight;
                    dmMode.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT;
                    if (targetFps > 0) {
                        dmMode.dmDisplayFrequency = targetFps;
                        dmMode.dmFields |= DM_DISPLAYFREQUENCY;
                    }
                    LONG ret = ChangeDisplaySettingsExW(disp.deviceName.c_str(), &dmMode, NULL, CDS_UPDATEREGISTRY, NULL);
                    if (ret == DISP_CHANGE_SUCCESSFUL) {
                        disp.width = targetWidth;
                        disp.height = targetHeight;
                        if (targetFps > 0) disp.fps = targetFps;
                        std::wcout << L"[Display] Dynamically updated virtual display to "
                                   << targetWidth << L"x" << targetHeight << L" @" << targetFps << L"Hz" << std::endl;
                    }
                }
            }
        }

        targetWidth = disp.width;
        targetHeight = disp.height;
        if (targetFps <= 0 && disp.fps > 0) {
            targetFps = disp.fps;
        }

        // Send Config Packet to Tablet
        PacketHeader cfgHeader = { 0 };
        cfgHeader.magic = htonl(REDISPLAY_MAGIC);
        cfgHeader.packet_type = PACKET_TYPE_CONFIG;
        cfgHeader.payload_size = htonl(sizeof(ConfigPayload));

        ConfigPayload cfgPayload;
        cfgPayload.width = htonl(targetWidth);
        cfgPayload.height = htonl(targetHeight);
        cfgPayload.fps = htonl(targetFps);

        send(sock, (char*)&cfgHeader, sizeof(cfgHeader), 0);
        send(sock, (char*)&cfgPayload, sizeof(cfgPayload), 0);

        // Create D3D11 Device
        ID3D11Device* pD3DDevice = nullptr;
        ID3D11DeviceContext* pD3DContext = nullptr;
        D3D_FEATURE_LEVEL feat;
        HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 
                                       D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, 
                                       D3D11_SDK_VERSION, &pD3DDevice, &feat, &pD3DContext);
        if (FAILED(hr)) {
            if (isGui) {
                std::cout << "{\"type\":\"state\",\"status\":\"error\",\"message\":\"D3D11 device creation failed\"}" << std::endl;
            } else {
                std::cerr << "[D3D11] Failed to create device" << std::endl;
            }
            closesocket(sock);
            continue;
        }

        // Initialize NVENC
        NvEncoderD3D11 encoder;
        if (!encoder.Initialize(pD3DDevice, targetWidth, targetHeight, targetFps, bitrateMbps)) {
            if (isGui) {
                std::cout << "{\"type\":\"state\",\"status\":\"error\",\"message\":\"NVENC encoder initialization failed\"}" << std::endl;
            } else {
                std::cerr << "[NVENC] Encoder initialization failed" << std::endl;
            }
            pD3DContext->Release();
            pD3DDevice->Release();
            closesocket(sock);
            continue;
        }

        // Streaming Stats & Active Motion Cadence Tracker
        std::atomic<uint64_t> frameCount{ 0 };
        std::atomic<uint64_t> totalBytes{ 0 };
        std::atomic<uint64_t> droppedFrames{ 0 };
        std::atomic<uint64_t> totalEncodeTimeUs{ 0 };
        std::atomic<bool> connectionAlive{ true };
        std::atomic<uint64_t> lastFrameEncodeUs{ 0 };
        std::atomic<uint64_t> activeDeltaUsSum{ 0 };
        std::atomic<uint32_t> activeDeltaCount{ 0 };
        std::atomic<uint64_t> lastActiveMotionUs{ 0 };

        // Dedicated Async Network Dispatcher (queue bounds depend on Ring Buffer mode)
        int maxQueueSize = (bufferMode == "smooth") ? 12 : 2;
        AsyncNetworkSender asyncSender(sock, connectionAlive, frameCount, totalBytes, droppedFrames, maxQueueSize);
        asyncSender.Start();

        // Frame Callback: NVENC encode runs at ~3.2ms, packets queued immediately
        ScreenCapture capture;
        bool captureOk = capture.Initialize(pD3DDevice, disp.hMonitor, targetFps, [&](ID3D11Texture2D* pTexture, int w, int h) {
            if (!connectionAlive || !g_running) return;

            uint64_t t0 = GetTimestampUs();
            std::vector<uint8_t> bitstream;
            bool isKeyframe = false;

            if (encoder.EncodeFrame(pTexture, frameCount.load(), bitstream, isKeyframe)) {
                uint64_t nowUs = GetTimestampUs();
                uint64_t encodeDuration = nowUs - t0;
                totalEncodeTimeUs += encodeDuration;

                uint64_t prevUs = lastFrameEncodeUs.exchange(nowUs);
                if (prevUs > 0 && nowUs > prevUs) {
                    uint64_t dt = nowUs - prevUs;
                    // Consecutive frame interval between 3ms (~330fps) and 100ms (10fps) measures active motion cadence
                    if (dt >= 3000 && dt <= 100000) {
                        activeDeltaUsSum += dt;
                        activeDeltaCount++;
                    }
                }
                lastActiveMotionUs = nowUs;

                EncodedPacket pkt;
                pkt.hdr.magic = htonl(REDISPLAY_MAGIC);
                pkt.hdr.packet_type = PACKET_TYPE_VIDEO;
                pkt.hdr.flags = isKeyframe ? FLAG_KEYFRAME : FLAG_NONE;
                pkt.hdr.reserved = 0;
                
                // Big endian timestamp
                uint64_t ts = GetTimestampUs();
                uint32_t tsHi = (uint32_t)(ts >> 32);
                uint32_t tsLo = (uint32_t)(ts & 0xFFFFFFFF);
                pkt.hdr.timestamp_us = ((uint64_t)htonl(tsHi)) | (((uint64_t)htonl(tsLo)) << 32);
                pkt.hdr.payload_size = htonl((uint32_t)bitstream.size());
                pkt.bitstream = std::move(bitstream);
                pkt.frameIdx = frameCount.load();

                // Non-blocking handoff to async socket dispatcher (<0.01ms)
                asyncSender.Push(std::move(pkt));
            }
        });

        if (!captureOk) {
            if (isGui) {
                std::cout << "{\"type\":\"state\",\"status\":\"error\",\"message\":\"Screen capture initialization failed\"}" << std::endl;
            } else {
                std::cerr << "[Capture] Failed to initialize screen capture" << std::endl;
            }
            capture.Stop();
            asyncSender.Stop();
            encoder.Destroy();
            pD3DContext->Release();
            pD3DDevice->Release();
            closesocket(sock);
            continue;
        }

        capture.Start();

        if (isGui) {
            std::cout << "{\"type\":\"state\",\"status\":\"streaming\""
                      << ",\"display\":" << disp.index
                      << ",\"width\":" << targetWidth
                      << ",\"height\":" << targetHeight
                      << ",\"fps\":" << targetFps
                      << ",\"bitrate\":" << bitrateMbps
                      << ",\"device\":\"" << chosenModel << "\"}" << std::endl;
        } else {
            std::cout << "\n>>> [ReDisplay STREAMING ACTIVE] <<<" << std::endl;
            std::cout << "Display: " << targetWidth << "x" << targetHeight << " @" << targetFps << "Hz | Bitrate: " << bitrateMbps << " Mbps\n" << std::endl;
        }

        auto lastStatTime = std::chrono::steady_clock::now();
        uint64_t lastFrames = 0;
        uint64_t lastBytes = 0;
        uint64_t lastWgcFrames = 0;

        while (g_running && connectionAlive) {
            std::this_thread::sleep_for(std::chrono::milliseconds(500));

            auto now = std::chrono::steady_clock::now();
            double elapsed = std::chrono::duration<double>(now - lastStatTime).count();
            if (elapsed < 0.4) continue;
            lastStatTime = now;

            uint64_t currFrames = frameCount.load();
            uint64_t currBytes = totalBytes.load();
            uint64_t currWgcFrames = capture.GetArrivedFrameCount();
            uint64_t currDropped = droppedFrames.load();

            uint64_t nowUs = GetTimestampUs();
            uint64_t lastMotionUs = lastActiveMotionUs.load();
            bool isIdle = (lastMotionUs == 0 || (nowUs > lastMotionUs && (nowUs - lastMotionUs) > 350000));

            uint32_t deltaCount = activeDeltaCount.exchange(0);
            uint64_t deltaSumUs = activeDeltaUsSum.exchange(0);

            double fps = 0.0;
            if (isIdle) {
                fps = 0.0;
            } else if (deltaCount > 0 && deltaSumUs > 0) {
                double avgDeltaSec = ((double)deltaSumUs / deltaCount) / 1000000.0;
                double cadenceFps = 1.0 / avgDeltaSec;
                if (cadenceFps > (double)targetFps + 5.0) cadenceFps = (double)targetFps;
                fps = cadenceFps;
            } else if (currFrames > lastFrames) {
                double rawFps = (currFrames - lastFrames) / elapsed;
                if (rawFps > (double)targetFps + 5.0) rawFps = (double)targetFps;
                fps = rawFps;
            } else {
                fps = 0.0;
            }

            double wgcFps = isIdle ? 0.0 : (fps > 0 ? fps : (currWgcFrames - lastWgcFrames) / elapsed);
            double mbps = ((currBytes - lastBytes) * 8.0) / (elapsed * 1000000.0);
            double avgEncodeMs = (currFrames > lastFrames) ? 
                (double)(totalEncodeTimeUs.load()) / ((currFrames - lastFrames) * 1000.0) : 0.0;
            totalEncodeTimeUs = 0;

            lastFrames = currFrames;
            lastBytes = currBytes;
            lastWgcFrames = currWgcFrames;

            if (isGui) {
                std::cout << "{\"type\":\"stats\""
                          << ",\"fps\":" << std::fixed << std::setprecision(1) << fps
                          << ",\"wgcFps\":" << std::setprecision(1) << wgcFps
                          << ",\"mbps\":" << std::setprecision(1) << mbps
                          << ",\"encodeMs\":" << std::setprecision(2) << avgEncodeMs
                          << ",\"frames\":" << currFrames
                          << ",\"dropped\":" << currDropped
                          << ",\"bytes\":" << currBytes
                          << ",\"device\":\"" << chosenModel << "\"}" << std::endl;
            } else {
                std::cout << "\r[Stage 2 WGC] " << std::fixed << std::setprecision(1) << wgcFps << " FPS | "
                          << "[Stage 3 NVENC] " << fps << " FPS (" << std::setprecision(2) << avgEncodeMs << " ms) | "
                          << "[Stage 4 Host TCP] " << std::setprecision(1) << fps << " FPS (" << mbps << " Mbps) | "
                          << "Drop: " << currDropped << "    " << std::flush;
            }
        }

        capture.Stop();
        asyncSender.Stop();
        encoder.Destroy();
        pD3DContext->Release();
        pD3DDevice->Release();
        closesocket(sock);

        if (!g_running) break;
        if (isGui) {
            std::cout << "{\"type\":\"state\",\"status\":\"disconnected\",\"message\":\"Connection dropped, waiting to reconnect...\"}" << std::endl;
        } else {
            std::cout << "\nConnection dropped, waiting to reconnect..." << std::endl;
        }
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }

    WSACleanup();
    if (isGui) {
        std::cout << "{\"type\":\"state\",\"status\":\"stopped\"}" << std::endl;
    } else {
        std::cout << "\nReDisplay Host stopped." << std::endl;
    }
    timeEndPeriod(1);
    return 0;
}

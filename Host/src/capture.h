#pragma once
#include <windows.h>
#include <d3d11.h>
#include <memory>
#include <functional>
#include <chrono>

class ScreenCapture {
public:
    using FrameCallback = std::function<void(ID3D11Texture2D*, std::chrono::steady_clock::time_point)>;

    ScreenCapture();
    ~ScreenCapture();

    bool Initialize(ID3D11Device* pDevice, HMONITOR hMonitor, int targetFps, FrameCallback onFrame);
    bool Start();
    void Stop();

    int GetWidth() const { return m_width; }
    int GetHeight() const { return m_height; }
    uint64_t GetArrivedFrameCount() const;
    uint64_t GetSupersededFrameCount() const;
    bool IsHealthy() const;

private:
    struct Impl;
    std::shared_ptr<Impl> m_impl;
    int m_width;
    int m_height;
};

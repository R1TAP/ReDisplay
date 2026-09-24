#pragma once
#include <windows.h>
#include <d3d11.h>
#include <memory>
#include <functional>

class ScreenCapture {
public:
    using FrameCallback = std::function<void(ID3D11Texture2D* pTexture, int width, int height)>;

    ScreenCapture();
    ~ScreenCapture();

    bool Initialize(ID3D11Device* pDevice, HMONITOR hMonitor, int targetFps, FrameCallback onFrame);
    void Start();
    void Stop();

    int GetWidth() const { return m_width; }
    int GetHeight() const { return m_height; }
    uint64_t GetArrivedFrameCount() const;

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
    int m_width;
    int m_height;
};

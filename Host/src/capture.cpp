#include "capture.h"
#include <iostream>
#include <atomic>
#include <mutex>
#include <thread>
#include <dxgi.h>
#include <d3d11_4.h>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>

#pragma comment(lib, "windowsapp.lib")
#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "user32.lib")

extern "C" HRESULT WINAPI CreateDirect3D11DeviceFromDXGIDevice(IDXGIDevice* dxgiDevice, IInspectable** graphicsDevice);

struct ScreenCapture::Impl {
    winrt::Windows::Graphics::Capture::GraphicsCaptureItem item{ nullptr };
    winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool framePool{ nullptr };
    winrt::Windows::Graphics::Capture::GraphicsCaptureSession session{ nullptr };
    winrt::event_token frameArrivedToken;

    ID3D11Device* pD3DDevice = nullptr;
    ID3D11DeviceContext* pD3DContext = nullptr;
    winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice winrtDevice{ nullptr };
    FrameCallback onFrame;

    // Zero-copy drop-to-latest frame queue
    winrt::Windows::Graphics::Capture::Direct3D11CaptureFrame pendingFrame{ nullptr };
    std::mutex frameMutex;
    HANDLE hFrameEvent = NULL;
    std::thread workerThread;

    std::atomic<uint64_t> wgcArrivedCount{ 0 };
    std::atomic<bool> running{ false };
};

ScreenCapture::ScreenCapture() : m_impl(std::make_unique<Impl>()), m_width(0), m_height(0) {}
ScreenCapture::~ScreenCapture() { Stop(); }

uint64_t ScreenCapture::GetArrivedFrameCount() const {
    return m_impl ? m_impl->wgcArrivedCount.load() : 0;
}

bool ScreenCapture::Initialize(ID3D11Device* pDevice, HMONITOR hMonitor, int targetFps, FrameCallback onFrame) {
    m_impl->pD3DDevice = pDevice;
    pDevice->GetImmediateContext(&m_impl->pD3DContext);
    m_impl->onFrame = onFrame;

    // Create WinRT IDirect3DDevice from native D3D11Device
    IDXGIDevice* pDxgiDevice = nullptr;
    HRESULT hr = pDevice->QueryInterface(__uuidof(IDXGIDevice), (void**)&pDxgiDevice);
    if (FAILED(hr)) return false;

    IInspectable* inspectable = nullptr;
    hr = CreateDirect3D11DeviceFromDXGIDevice(pDxgiDevice, &inspectable);
    pDxgiDevice->Release();
    if (FAILED(hr)) return false;

    winrt::copy_from_abi(m_impl->winrtDevice, inspectable);
    inspectable->Release();

    // Create GraphicsCaptureItem for Monitor
    auto interop = winrt::get_activation_factory<winrt::Windows::Graphics::Capture::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
    hr = interop->CreateForMonitor(hMonitor, winrt::guid_of<winrt::Windows::Graphics::Capture::GraphicsCaptureItem>(), winrt::put_abi(m_impl->item));
    if (FAILED(hr) || !m_impl->item) {
        std::cerr << "[Capture] CreateForMonitor failed: 0x" << std::hex << hr << std::endl;
        return false;
    }

    auto sz = m_impl->item.Size();
    m_width = sz.Width;
    m_height = sz.Height;

    m_impl->hFrameEvent = CreateEvent(NULL, FALSE, FALSE, NULL);

    // Create Frame Pool with 3 buffers (zero-starvation async pipeline)
    m_impl->framePool = winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool::CreateFreeThreaded(
        m_impl->winrtDevice,
        winrt::Windows::Graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized,
        3,
        sz
    );

    // Frame arrived callback: drains pool, stores latest frame, signals worker (<0.02ms)
    m_impl->frameArrivedToken = m_impl->framePool.FrameArrived([this](auto const& sender, auto const&) {
        if (!m_impl->running) return;

        winrt::Windows::Graphics::Capture::Direct3D11CaptureFrame latestFrame{ nullptr };
        while (auto frame = sender.TryGetNextFrame()) {
            m_impl->wgcArrivedCount++;
            if (latestFrame) {
                latestFrame.Close();
            }
            latestFrame = frame;
        }

        if (!latestFrame) return;

        {
            std::lock_guard<std::mutex> lock(m_impl->frameMutex);
            if (m_impl->pendingFrame) {
                m_impl->pendingFrame.Close();
            }
            m_impl->pendingFrame = latestFrame;
        }
        SetEvent(m_impl->hFrameEvent);
    });

    // Create Session
    m_impl->session = m_impl->framePool.CreateCaptureSession(m_impl->item);

    // Try enabling hardware cursor if available (Win 10 2004+)
    try {
        m_impl->session.IsCursorCaptureEnabled(true);
    } catch (...) {}

    // Set minimum update interval according to targetFps (unlocked 0ms for 120Hz+, exact interval for lower)
    try {
        if (targetFps >= 120) {
            winrt::Windows::Foundation::TimeSpan interval{ std::chrono::milliseconds(0) };
            m_impl->session.MinUpdateInterval(interval);
            std::cout << "[Capture] Unlocked MinUpdateInterval (0ms) for high-refresh " << targetFps << "Hz" << std::endl;
        } else if (targetFps > 0) {
            int intervalMs = (int)(1000.0 / targetFps * 0.95);
            if (intervalMs < 1) intervalMs = 1;
            winrt::Windows::Foundation::TimeSpan interval{ std::chrono::milliseconds(intervalMs) };
            m_impl->session.MinUpdateInterval(interval);
            std::cout << "[Capture] Set MinUpdateInterval to " << intervalMs << "ms (target " << targetFps << "Hz)" << std::endl;
        }
    } catch (...) {}

    std::cout << "[Capture] Windows.Graphics.Capture initialized: " << m_width << "x" << m_height << " (3-buffer zero-copy direct handoff)" << std::endl;
    return true;
}

void ScreenCapture::Start() {
    if (m_impl->session && !m_impl->running) {
        m_impl->running = true;

        // Dedicated high-priority worker thread for encoding
        m_impl->workerThread = std::thread([this]() {
            SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
            while (m_impl->running) {
                DWORD wr = WaitForSingleObject(m_impl->hFrameEvent, 10);
                if (!m_impl->running) break;

                winrt::Windows::Graphics::Capture::Direct3D11CaptureFrame curFrame{ nullptr };
                {
                    std::lock_guard<std::mutex> lock(m_impl->frameMutex);
                    curFrame = m_impl->pendingFrame;
                    m_impl->pendingFrame = nullptr;
                }

                if (curFrame) {
                    auto surface = curFrame.Surface();
                    auto access = surface.as<Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();

                    ID3D11Texture2D* pTexture = nullptr;
                    if (SUCCEEDED(access->GetInterface(IID_PPV_ARGS(&pTexture))) && pTexture) {
                        if (m_impl->onFrame) {
                            m_impl->onFrame(pTexture, m_width, m_height);
                        }
                        pTexture->Release();
                    }
                    curFrame.Close();
                }
            }
        });

        m_impl->session.StartCapture();
        std::cout << "[Capture] Capture session started" << std::endl;
    }
}

void ScreenCapture::Stop() {
    m_impl->running = false;
    if (m_impl->hFrameEvent) {
        SetEvent(m_impl->hFrameEvent);
    }
    if (m_impl->workerThread.joinable()) {
        m_impl->workerThread.join();
    }
    if (m_impl->hFrameEvent) {
        CloseHandle(m_impl->hFrameEvent);
        m_impl->hFrameEvent = NULL;
    }
    {
        std::lock_guard<std::mutex> lock(m_impl->frameMutex);
        if (m_impl->pendingFrame) {
            m_impl->pendingFrame.Close();
            m_impl->pendingFrame = nullptr;
        }
    }
    if (m_impl->session) {
        try {
            m_impl->session.Close();
        } catch (...) {}
        m_impl->session = nullptr;
    }
    if (m_impl->framePool) {
        try {
            m_impl->framePool.FrameArrived(m_impl->frameArrivedToken);
            m_impl->framePool.Close();
        } catch (...) {}
        m_impl->framePool = nullptr;
    }
    if (m_impl->pD3DContext) {
        m_impl->pD3DContext->Release();
        m_impl->pD3DContext = nullptr;
    }
}

#include "capture.h"
#include <iostream>
#include <array>
#include <atomic>
#include <chrono>
#include <mutex>
#include <thread>
#include <dxgi.h>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>

#pragma comment(lib, "windowsapp.lib")

using namespace winrt::Windows::Graphics::Capture;
using namespace std::chrono;

struct ScreenCapture::Impl {
    GraphicsCaptureItem item{ nullptr };
    Direct3D11CaptureFramePool framePool{ nullptr };
    GraphicsCaptureSession session{ nullptr };
    Direct3D11CaptureFramePool::FrameArrived_revoker arrived;
    GraphicsCaptureItem::Closed_revoker closed;

    Direct3D11CaptureFrame pendingFrame{ nullptr };
    std::mutex frameMutex;
    winrt::handle frameEvent;
    winrt::handle stopEvent;
    winrt::handle paceTimer;
    std::thread worker;
    FrameCallback onFrame;
    std::atomic<uint64_t> arrivedCount{ 0 };
    std::atomic<bool> running{ false };
    std::atomic<bool> healthy{ true };
    winrt::Windows::Graphics::SizeInt32 size{};
    int targetFps = 60;
};

ScreenCapture::ScreenCapture() : m_impl(std::make_shared<Impl>()), m_width(0), m_height(0) {}
ScreenCapture::~ScreenCapture() { Stop(); }

uint64_t ScreenCapture::GetArrivedFrameCount() const { return m_impl->arrivedCount; }
bool ScreenCapture::IsHealthy() const { return m_impl->healthy; }

bool ScreenCapture::Initialize(ID3D11Device* device, HMONITOR monitor, int targetFps, FrameCallback onFrame) {
    try {
        auto& state = *m_impl;
        state.onFrame = std::move(onFrame);
        state.targetFps = targetFps;

        winrt::com_ptr<IDXGIDevice> dxgiDevice;
        winrt::check_hresult(device->QueryInterface(IID_PPV_ARGS(dxgiDevice.put())));
        winrt::com_ptr<IInspectable> inspectable;
        winrt::check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.get(), inspectable.put()));
        auto winrtDevice = inspectable.as<winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice>();

        auto interop = winrt::get_activation_factory<GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
        winrt::check_hresult(interop->CreateForMonitor(monitor, winrt::guid_of<GraphicsCaptureItem>(), winrt::put_abi(state.item)));
        state.size = state.item.Size();
        m_width = state.size.Width;
        m_height = state.size.Height;
        state.frameEvent.attach(CreateEventW(nullptr, FALSE, FALSE, nullptr));
        state.stopEvent.attach(CreateEventW(nullptr, TRUE, FALSE, nullptr));
        state.paceTimer.attach(CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                                                      TIMER_MODIFY_STATE | SYNCHRONIZE));
        if (!state.paceTimer) {
            state.paceTimer.attach(CreateWaitableTimerExW(nullptr, nullptr, 0, TIMER_MODIFY_STATE | SYNCHRONIZE));
        }
        if (!state.frameEvent || !state.stopEvent || !state.paceTimer) return false;

        state.framePool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            winrtDevice, winrt::Windows::Graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized, 3, state.size);
        std::weak_ptr<Impl> weakState = m_impl;
        state.arrived = state.framePool.FrameArrived(winrt::auto_revoke, [weakState](auto const& sender, auto const&) {
            auto state = weakState.lock();
            if (!state || !state->running) return;
            try {
                Direct3D11CaptureFrame latest{ nullptr };
                while (auto frame = sender.TryGetNextFrame()) {
                    ++state->arrivedCount;
                    latest = std::move(frame);
                }
                if (!latest) return;

                std::lock_guard lock(state->frameMutex);
                if (!state->running) return;
                state->pendingFrame = std::move(latest);
                SetEvent(state->frameEvent.get());
            } catch (const winrt::hresult_error&) {
                state->healthy = false;
            }
        });
        state.closed = state.item.Closed(winrt::auto_revoke, [weakState](auto const&, auto const&) {
            if (auto state = weakState.lock()) state->healthy = false;
        });
        state.session = state.framePool.CreateCaptureSession(state.item);
        try { state.session.IsCursorCaptureEnabled(true); } catch (const winrt::hresult_error&) {}
        try {
            state.session.MinUpdateInterval(winrt::Windows::Foundation::TimeSpan{ 0 });
        } catch (const winrt::hresult_error&) {}
        return true;
    } catch (const winrt::hresult_error& error) {
        std::cerr << "[Capture] Initialization failed: " << winrt::to_string(error.message()) << '\n';
        return false;
    }
}

bool ScreenCapture::Start() {
    auto& state = *m_impl;
    state.running = true;
    try {
        state.worker = std::thread([&state]() {
            try {
                winrt::init_apartment(winrt::apartment_type::multi_threaded);
                SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);
                using CaptureTicks = duration<int64_t, std::ratio<1, 10000000>>;
                const auto interval = CaptureTicks{ 10000000 / state.targetFps };
                const auto frameWait = std::array{ state.stopEvent.get(), state.frameEvent.get() };
                const auto paceWait = std::array{ state.stopEvent.get(), state.paceTimer.get() };
                steady_clock::time_point next{};
                while (state.running && state.healthy) {
                    const auto result = WaitForMultipleObjects(static_cast<DWORD>(frameWait.size()),
                                                               frameWait.data(), FALSE, INFINITE);
                    if (result == WAIT_OBJECT_0 || !state.running) break;
                    if (result != WAIT_OBJECT_0 + 1) {
                        state.healthy = false;
                        break;
                    }

                    // At a lower target, sample the newest frame at the deadline. Dropping by
                    // source timestamp alone made a 180 Hz source alternate 5.6 and 11.1 ms at 120 FPS.
                    const auto remaining = duration_cast<CaptureTicks>(next - steady_clock::now());
                    if (remaining > microseconds{ 180 }) {
                        LARGE_INTEGER due{};
                        due.QuadPart = -remaining.count();
                        if (SetWaitableTimer(state.paceTimer.get(), &due, 0, nullptr, nullptr, FALSE)) {
                            const auto paced = WaitForMultipleObjects(static_cast<DWORD>(paceWait.size()),
                                                                     paceWait.data(), FALSE, INFINITE);
                            if (paced == WAIT_OBJECT_0 || !state.running) break;
                            if (paced != WAIT_OBJECT_0 + 1) {
                                state.healthy = false;
                                break;
                            }
                        }
                    }

                    Direct3D11CaptureFrame frame{ nullptr };
                    {
                        std::lock_guard lock(state.frameMutex);
                        frame = std::move(state.pendingFrame);
                        ResetEvent(state.frameEvent.get());
                    }
                    if (!frame) continue;
                    auto size = frame.ContentSize();
                    if (size.Width != state.size.Width || size.Height != state.size.Height) {
                        std::cerr << "[Capture] Monitor size changed, restarting capture\n";
                        state.healthy = false;
                        break;
                    }

                    const auto now = steady_clock::now();
                    if (now > next + interval / 2) next = now;
                    next += interval;
                    auto access = frame.Surface().as<Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
                    winrt::com_ptr<ID3D11Texture2D> texture;
                    winrt::check_hresult(access->GetInterface(IID_PPV_ARGS(texture.put())));
                    state.onFrame(texture.get(), size.Width, size.Height);
                }
                winrt::uninit_apartment();
            } catch (const std::exception& error) {
                std::cerr << "[Capture] Worker failed: " << error.what() << '\n';
                state.healthy = false;
            } catch (const winrt::hresult_error& error) {
                std::cerr << "[Capture] Worker failed: " << winrt::to_string(error.message()) << '\n';
                state.healthy = false;
            }
        });
        state.session.StartCapture();
        return true;
    } catch (const winrt::hresult_error& error) {
        std::cerr << "[Capture] Start failed: " << winrt::to_string(error.message()) << '\n';
    } catch (const std::exception& error) {
        std::cerr << "[Capture] Start failed: " << error.what() << '\n';
    }
    Stop();
    return false;
}

void ScreenCapture::Stop() {
    auto& state = *m_impl;
    state.running = false;
    state.arrived.revoke();
    state.closed.revoke();
    if (state.stopEvent) SetEvent(state.stopEvent.get());
    if (state.worker.joinable()) state.worker.join();
    {
        std::lock_guard lock(state.frameMutex);
        state.pendingFrame = nullptr;
        state.frameEvent.close();
        state.stopEvent.close();
        state.paceTimer.close();
    }
    if (state.session) {
        try { state.session.Close(); } catch (const winrt::hresult_error&) {}
        state.session = nullptr;
    }
    if (state.framePool) {
        try { state.framePool.Close(); } catch (const winrt::hresult_error&) {}
        state.framePool = nullptr;
    }
    state.item = nullptr;
}

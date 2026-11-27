#pragma once
#include <winsock2.h>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <optional>
#include <thread>
#include <utility>
#include <vector>

#include "protocol.h"

inline uint64_t Network64(uint64_t value) {
    return (static_cast<uint64_t>(htonl(static_cast<uint32_t>(value))) << 32) |
           htonl(static_cast<uint32_t>(value >> 32));
}

inline uint64_t ClockUs(std::chrono::steady_clock::time_point time) {
    return std::chrono::duration_cast<std::chrono::microseconds>(time.time_since_epoch()).count();
}

struct EncodedPacket {
    PacketHeader header{};
    std::vector<uint8_t> payload;
    std::chrono::steady_clock::time_point encodedAt;
};

struct NetworkStats {
    uint64_t frames = 0;
    uint64_t bytes = 0;
    uint64_t dropped = 0;
    uint64_t sendSamples = 0;
    uint64_t sendUs = 0;
    uint64_t sendMaxUs = 0;
    uint64_t encodeToSendUs = 0;
    std::vector<std::array<uint64_t, 3>> trace;
    size_t queueDepth = 0;
    size_t queuePeak = 0;
};

inline bool SendPacket(SOCKET socket, const PacketHeader& header, const void* payload, ULONG payloadSize) {
    WSABUF buffers[]{
        { sizeof(header), reinterpret_cast<char*>(const_cast<PacketHeader*>(&header)) },
        { payloadSize, static_cast<char*>(const_cast<void*>(payload)) }
    };
    const int count = payloadSize ? 2 : 1;
    int first = 0;
    while (first < count) {
        DWORD sent = 0;
        if (WSASend(socket, buffers + first, count - first, &sent, 0, nullptr, nullptr) != 0 || sent == 0) {
            return false;
        }
        while (first < count && sent >= buffers[first].len) {
            sent -= buffers[first++].len;
        }
        if (first < count) {
            buffers[first].buf += sent;
            buffers[first].len -= sent;
        }
    }
    return true;
}

class AsyncNetworkSender {
public:
    AsyncNetworkSender(SOCKET socket, size_t queueLimit, bool trace = false)
        : m_socket(socket), m_queueLimit(queueLimit), m_trace(trace) {}
    ~AsyncNetworkSender() { Stop(); }

    void Start() { m_worker = std::thread([this] { Run(); }); }

    std::vector<uint8_t> TakePayloadBuffer() {
        std::lock_guard lock(m_mutex);
        return std::move(m_recycledPayload);
    }

    // After any reference frame is discarded, the next queued picture must be an IDR.
    bool Push(EncodedPacket&& packet) {
        std::lock_guard lock(m_mutex);
        if (m_queue.size() == m_queueLimit) {
            m_dropped += m_queue.size();
            m_queue.clear();
            if (!(packet.header.flags & FLAG_KEYFRAME)) {
                ++m_dropped;
                return false;
            }
        }
        m_queue.push_back(std::move(packet));
        if (m_queue.size() > m_stats.queuePeak) m_stats.queuePeak = m_queue.size();
        m_ready.notify_one();
        return true;
    }

    void SetInputMode(bool enabled, uint64_t generation) {
        std::lock_guard lock(m_mutex);
        m_inputMode = PacketHeader{htonl(REDISPLAY_MAGIC), PACKET_TYPE_INPUT_MODE, static_cast<uint8_t>(enabled),
                                   0, Network64(generation), 0};
        m_ready.notify_one();
    }

    void Stop() {
        {
            std::lock_guard lock(m_mutex);
            m_stopping = true;
        }
        m_ready.notify_one();
        if (m_worker.joinable()) {
            shutdown(m_socket, SD_BOTH);
            m_worker.join();
        }
    }

    NetworkStats TakeStats() {
        std::lock_guard lock(m_mutex);
        m_stats.dropped = m_dropped;
        m_stats.queueDepth = m_queue.size();
        auto snapshot = std::move(m_stats);
        m_stats = {};
        m_stats.frames = snapshot.frames;
        m_stats.bytes = snapshot.bytes;
        m_stats.queuePeak = snapshot.queueDepth;
        return snapshot;
    }

    std::atomic<bool> alive{ true };

private:
    void Run() {
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);
        using namespace std::chrono;
        auto nextPing = steady_clock::now();
        for (;;) {
            EncodedPacket packet;
            std::optional<PacketHeader> control;
            {
                std::unique_lock lock(m_mutex);
                auto ready = [this] { return m_stopping || m_inputMode || !m_queue.empty(); };
                m_ready.wait_until(lock, nextPing, ready);
                if (m_stopping) break;
                if (m_inputMode) {
                    control = std::exchange(m_inputMode, std::nullopt);
                } else if (const auto now = steady_clock::now(); now >= nextPing) {
                    nextPing = now + seconds(1);
                    control = PacketHeader{htonl(REDISPLAY_MAGIC), PACKET_TYPE_PING, 0, 0, Network64(ClockUs(now)), 0};
                } else {
                    packet = std::move(m_queue.front());
                    m_queue.pop_front();
                }
            }
            if (control) {
                if (SendPacket(m_socket, *control, nullptr, 0)) continue;
                alive = false;
                break;
            }
            const auto start = std::chrono::steady_clock::now();
            if (!SendPacket(m_socket, packet.header, packet.payload.data(), static_cast<ULONG>(packet.payload.size()))) {
                alive = false;
                break;
            }
            const auto end = std::chrono::steady_clock::now();
            using std::chrono::microseconds;
            const auto sendUs = static_cast<uint64_t>(std::chrono::duration_cast<microseconds>(end - start).count());
            std::lock_guard lock(m_mutex);
            ++m_stats.frames;
            m_stats.bytes += sizeof(packet.header) + packet.payload.size();
            ++m_stats.sendSamples;
            m_stats.sendUs += sendUs;
            if (sendUs > m_stats.sendMaxUs) m_stats.sendMaxUs = sendUs;
            m_stats.encodeToSendUs += std::chrono::duration_cast<microseconds>(end - packet.encodedAt).count();
            if (m_trace && m_stats.trace.size() < 1024) {
                m_stats.trace.push_back({Network64(packet.header.timestamp_us), ClockUs(packet.encodedAt), ClockUs(end)});
            }
            m_recycledPayload.swap(packet.payload);
        }
    }

    SOCKET m_socket;
    size_t m_queueLimit;
    bool m_trace;
    std::mutex m_mutex;
    std::condition_variable m_ready;
    std::deque<EncodedPacket> m_queue;
    std::optional<PacketHeader> m_inputMode;
    std::vector<uint8_t> m_recycledPayload;
    NetworkStats m_stats;
    uint64_t m_dropped = 0;
    bool m_stopping = false;
    std::thread m_worker;
};

#pragma once
#include <winsock2.h>
#include <atomic>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <thread>
#include <vector>

#include "protocol.h"

struct EncodedPacket {
    PacketHeader header{};
    std::vector<uint8_t> payload;
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
    AsyncNetworkSender(SOCKET socket, size_t queueLimit) : m_socket(socket), m_queueLimit(queueLimit) {}
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
            dropped += m_queue.size();
            m_queue.clear();
            if (!(packet.header.flags & FLAG_KEYFRAME)) {
                ++dropped;
                return false;
            }
        }
        m_queue.push_back(std::move(packet));
        m_ready.notify_one();
        return true;
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

    std::atomic<bool> alive{ true };
    std::atomic<uint64_t> frames{ 0 };
    std::atomic<uint64_t> bytes{ 0 };
    std::atomic<uint64_t> dropped{ 0 };

private:
    void Run() {
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);
        for (;;) {
            EncodedPacket packet;
            {
                std::unique_lock lock(m_mutex);
                m_ready.wait(lock, [this] { return m_stopping || !m_queue.empty(); });
                if (m_stopping) break;
                packet = std::move(m_queue.front());
                m_queue.pop_front();
            }
            if (!SendPacket(m_socket, packet.header, packet.payload.data(), static_cast<ULONG>(packet.payload.size()))) {
                alive = false;
                break;
            }
            ++frames;
            bytes += sizeof(packet.header) + packet.payload.size();
            {
                std::lock_guard lock(m_mutex);
                m_recycledPayload.swap(packet.payload);
            }
        }
    }

    SOCKET m_socket;
    size_t m_queueLimit;
    std::mutex m_mutex;
    std::condition_variable m_ready;
    std::deque<EncodedPacket> m_queue;
    std::vector<uint8_t> m_recycledPayload;
    bool m_stopping = false;
    std::thread m_worker;
};

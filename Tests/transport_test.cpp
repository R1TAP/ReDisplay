#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <algorithm>
#include <cassert>
#include <cstring>
#include <iostream>
#include <vector>

static std::vector<char> wire;
static size_t chunkIndex;
static bool rejectSend;

static int WINAPI SendInChunks(SOCKET, LPWSABUF buffers, DWORD count, LPDWORD written,
                               DWORD, LPWSAOVERLAPPED, LPWSAOVERLAPPED_COMPLETION_ROUTINE) {
    if (rejectSend) return SOCKET_ERROR;
    constexpr DWORD chunkSizes[]{ 3, 19, 4 };
    DWORD remaining = chunkSizes[chunkIndex++ % _countof(chunkSizes)];
    *written = 0;
    for (DWORD i = 0; i < count && remaining; ++i) {
        const DWORD length = (std::min)(remaining, buffers[i].len);
        wire.insert(wire.end(), buffers[i].buf, buffers[i].buf + length);
        *written += length;
        remaining -= length;
    }
    return 0;
}

#define WSASend SendInChunks
#include "../Host/src/transport.h"
#undef WSASend

static EncodedPacket Frame(bool isIdr) {
    EncodedPacket packet;
    packet.header.flags = isIdr ? FLAG_KEYFRAME : FLAG_NONE;
    return packet;
}

int main() {
    const PacketHeader header{ 0x50445352, PACKET_TYPE_VIDEO, FLAG_KEYFRAME, 0, 5678, 9 };
    const char payload[] = "frame1234";
    assert(SendPacket(INVALID_SOCKET, header, payload, sizeof(payload) - 1));
    assert(chunkIndex > 1);
    assert(wire.size() == sizeof(header) + sizeof(payload) - 1);
    assert(std::memcmp(wire.data(), &header, sizeof(header)) == 0);
    assert(std::memcmp(wire.data() + sizeof(header), payload, sizeof(payload) - 1) == 0);
    wire.clear();
    assert(SendPacket(INVALID_SOCKET, header, nullptr, 0));
    assert(wire.size() == sizeof(header));
    rejectSend = true;
    assert(!SendPacket(INVALID_SOCKET, header, payload, sizeof(payload) - 1));

    for (const size_t limit : { 2, 12 }) {
        AsyncNetworkSender sender(INVALID_SOCKET, limit);
        assert(sender.Push(Frame(true)));
        for (size_t i = 1; i < limit; ++i) assert(sender.Push(Frame(false)));
        assert(!sender.Push(Frame(false)));
        const auto overflow = sender.TakeStats();
        assert(overflow.dropped == limit + 1 && overflow.queueDepth == 0 && overflow.queuePeak == limit);
        assert(sender.Push(Frame(true)));
        for (size_t i = 1; i < limit; ++i) assert(sender.Push(Frame(false)));
        assert(sender.Push(Frame(true)));
        const auto recovery = sender.TakeStats();
        assert(recovery.dropped == 2 * limit + 1 && recovery.queueDepth == 1 && recovery.queuePeak == limit);
    }
    std::cout << "Partial header/payload writes, send failure and IDR-safe bounded queues passed.\n";
}

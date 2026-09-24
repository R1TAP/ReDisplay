#pragma once
#include <cstdint>

#pragma pack(push, 1)

constexpr uint32_t REDISPLAY_MAGIC = 0x52445350; // "RDSP"

enum PacketType : uint8_t {
    PACKET_TYPE_VIDEO = 1,
    PACKET_TYPE_CONFIG = 2,
    PACKET_TYPE_PING = 3,
    PACKET_TYPE_PONG = 4
};

enum PacketFlags : uint8_t {
    FLAG_NONE = 0,
    FLAG_KEYFRAME = 1 << 0
};

struct PacketHeader {
    uint32_t magic;         // 0x52445350
    uint8_t  packet_type;   // PacketType
    uint8_t  flags;         // PacketFlags
    uint16_t reserved;      // 0
    uint64_t timestamp_us;  // Microsecond timestamp
    uint32_t payload_size;  // Size in bytes
};

struct ConfigPayload {
    uint32_t width;
    uint32_t height;
    uint32_t fps;
};

#pragma pack(pop)

#pragma once
#include <winsock2.h>
#include <windows.h>
#include <bcrypt.h>
#include <array>
#include <string>
#pragma comment(lib, "bcrypt.lib")

// ADB provisions a fresh bootstrap key for each launch. The abstract socket
// also checks the kernel-reported UID of adbd before accepting the handshake.
class SessionKey {
    using Bytes = std::array<unsigned char, 32>;
    Bytes key{};
    static bool Random(Bytes& bytes) {
        return BCryptGenRandom(nullptr, bytes.data(), ULONG(bytes.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0;
    }
    static std::string Hex(const Bytes& bytes) {
        constexpr char digits[] = "0123456789abcdef";
        std::string result;
        for (auto c : bytes) {
            result.push_back(digits[c >> 4]);
            result.push_back(digits[c & 15]);
        }
        return result;
    }
    static bool Transfer(SOCKET socket, void* data, int size, bool write) {
        char* p = static_cast<char*>(data);
        while (size > 0) {
            int n = write ? send(socket, p, size, 0) : recv(socket, p, size, 0);
            if (n <= 0) return false;
            size -= n;
            p += n;
        }
        return true;
    }
public:
    std::string endpoint;
    bool Generate() {
        Bytes name{};
        if (!Random(key) || !Random(name)) return false;
        endpoint = "redisplay13_" + Hex(name).substr(0, 32);
        return true;
    }
    std::string BootstrapKey() const { return Hex(key); }
    bool Authenticate(SOCKET socket) {
        Bytes hostNonce{}, clientNonce{}, clientProof{}, proof{};
        if (!Random(hostNonce) || !Transfer(socket, hostNonce.data(), 32, true) ||
            !Transfer(socket, clientNonce.data(), 32, false) || !Transfer(socket, clientProof.data(), 32, false)) return false;
        std::array<unsigned char, 65> challenge{};
        std::copy(hostNonce.begin(), hostNonce.end(), challenge.begin() + 1);
        std::copy(clientNonce.begin(), clientNonce.end(), challenge.begin() + 33);
        auto sign = [&](unsigned char role) {
            challenge[0] = role;
            return BCryptHash(BCRYPT_HMAC_SHA256_ALG_HANDLE, key.data(), ULONG(key.size()),
                challenge.data(), ULONG(challenge.size()), proof.data(), ULONG(proof.size())) == 0;
        };
        if (!sign('A')) return false;
        unsigned difference = 0;
        for (size_t i = 0; i < proof.size(); ++i) difference |= proof[i] ^ clientProof[i];
        return difference == 0 && sign('W') && Transfer(socket, proof.data(), 32, true);
    }
    ~SessionKey() { SecureZeroMemory(key.data(), key.size()); }
};

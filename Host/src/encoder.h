#pragma once
#include <windows.h>
#include <d3d11.h>
#include <vector>
#include <cstdint>
#include <string_view>
#include "nvEncodeAPI.h"

#include <unordered_map>
#include <winrt/base.h>

class NvEncoderD3D11 {
public:
    NvEncoderD3D11();
    ~NvEncoderD3D11();

    bool Initialize(ID3D11Device* pDevice, int width, int height, int fps, int bitrateMbps, std::string_view profile);
    bool EncodeFrame(ID3D11Texture2D* pTexture, bool forceIdr, std::vector<uint8_t>& outBitstream, bool& isKeyframe);
    void Destroy();

    const char* PresetName() const { return m_officePreset ? "P2/ULL" : "P1/ULL"; }
    unsigned VbvFrames() const { return m_vbvFrames; }
    int GetWidth() const { return m_width; }
    int GetHeight() const { return m_height; }

private:
    HMODULE m_hNvEnc;
    NV_ENCODE_API_FUNCTION_LIST m_nvList;
    void* m_hEncoder;
    ID3D11Device* m_pDevice;
    int m_width;
    int m_height;
    int m_fps;
    int m_bitrateMbps;

    NV_ENC_OUTPUT_PTR m_bitstreamBuffer;
    bool m_initialized;
    bool m_officePreset = false;
    unsigned m_vbvFrames = 2;
    struct RegisteredTexture {
        winrt::com_ptr<ID3D11Texture2D> texture;
        NV_ENC_REGISTERED_PTR resource;
    };
    std::unordered_map<ID3D11Texture2D*, RegisteredTexture> m_registeredResources;
};

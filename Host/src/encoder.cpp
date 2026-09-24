#include "encoder.h"
#include <iostream>

typedef NVENCSTATUS(NVENCAPI* PNVENCODEAPICREATEINSTANCE)(NV_ENCODE_API_FUNCTION_LIST* functionList);

NvEncoderD3D11::NvEncoderD3D11() 
    : m_hNvEnc(NULL), m_hEncoder(NULL), m_pDevice(NULL), 
      m_width(0), m_height(0), m_fps(60), m_bitrateMbps(60),
      m_bitstreamBuffer(NULL), m_initialized(false) {
    ZeroMemory(&m_nvList, sizeof(m_nvList));
}

NvEncoderD3D11::~NvEncoderD3D11() {
    Destroy();
}

bool NvEncoderD3D11::Initialize(ID3D11Device* pDevice, int width, int height, int fps, int bitrateMbps) {
    Destroy();

    m_pDevice = pDevice;
    m_width = width;
    m_height = height;
    m_fps = fps;
    m_bitrateMbps = bitrateMbps;

    m_hNvEnc = LoadLibraryA("nvEncodeAPI64.dll");
    if (!m_hNvEnc) {
        std::cerr << "[NVENC] Failed to load nvEncodeAPI64.dll" << std::endl;
        return false;
    }

    auto pfnCreateInstance = (PNVENCODEAPICREATEINSTANCE)GetProcAddress(m_hNvEnc, "NvEncodeAPICreateInstance");
    if (!pfnCreateInstance) {
        std::cerr << "[NVENC] GetProcAddress NvEncodeAPICreateInstance failed" << std::endl;
        return false;
    }

    m_nvList.version = NV_ENCODE_API_FUNCTION_LIST_VER;
    NVENCSTATUS status = pfnCreateInstance(&m_nvList);
    if (status != NV_ENC_SUCCESS) {
        std::cerr << "[NVENC] NvEncodeAPICreateInstance error: " << status << std::endl;
        return false;
    }

    // Open Encode Session
    NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS openParams = { 0 };
    openParams.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
    openParams.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX;
    openParams.device = m_pDevice;
    openParams.apiVersion = NVENCAPI_VERSION;

    status = m_nvList.nvEncOpenEncodeSessionEx(&openParams, &m_hEncoder);
    if (status != NV_ENC_SUCCESS || !m_hEncoder) {
        std::cerr << "[NVENC] nvEncOpenEncodeSessionEx error: " << status << std::endl;
        return false;
    }

    // Get Low Latency Preset Config (NVENC 13.1 P1 + Ultra Low Latency)
    NV_ENC_PRESET_CONFIG presetConfig = { 0 };
    presetConfig.version = NV_ENC_PRESET_CONFIG_VER;
    presetConfig.presetCfg.version = NV_ENC_CONFIG_VER;

    status = m_nvList.nvEncGetEncodePresetConfigEx(m_hEncoder, NV_ENC_CODEC_H264_GUID, NV_ENC_PRESET_P1_GUID, NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY, &presetConfig);
    if (status != NV_ENC_SUCCESS) {
        std::cerr << "[NVENC] nvEncGetEncodePresetConfigEx error: " << status << std::endl;
        return false;
    }

    // Initialize Encode Configuration
    NV_ENC_CONFIG encConfig;
    CopyMemory(&encConfig, &presetConfig.presetCfg, sizeof(NV_ENC_CONFIG));

    encConfig.gopLength = m_fps; // 1 second GOP
    encConfig.frameIntervalP = 1; // 0 B-frames
    encConfig.encodeCodecConfig.h264Config.idrPeriod = m_fps;
    encConfig.encodeCodecConfig.h264Config.repeatSPSPPS = 1; // Repeat SPS/PPS for robustness
    encConfig.encodeCodecConfig.h264Config.outputAUD = 0;

    // CBR single-pass ultra low latency rate control (disable multi-pass to avoid doubling encode time)
    encConfig.rcParams.rateControlMode = NV_ENC_PARAMS_RC_CBR;
    encConfig.rcParams.multiPass = NV_ENC_MULTI_PASS_DISABLED;
    encConfig.rcParams.enableLookahead = 0;
    encConfig.rcParams.enableAQ = 0;
    encConfig.rcParams.enableTemporalAQ = 0;
    encConfig.rcParams.averageBitRate = (uint32_t)m_bitrateMbps * 1000 * 1000;
    encConfig.rcParams.maxBitRate = (uint32_t)m_bitrateMbps * 1000 * 1000;
    encConfig.rcParams.vbvBufferSize = (uint32_t)m_bitrateMbps * 1000 * 1000 / m_fps * 2;
    encConfig.rcParams.zeroReorderDelay = 1;

    NV_ENC_INITIALIZE_PARAMS initParams = { 0 };
    initParams.version = NV_ENC_INITIALIZE_PARAMS_VER;
    initParams.encodeGUID = NV_ENC_CODEC_H264_GUID;
    initParams.presetGUID = NV_ENC_PRESET_P1_GUID;
    initParams.tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;
    initParams.encodeWidth = m_width;
    initParams.encodeHeight = m_height;
    initParams.darWidth = m_width;
    initParams.darHeight = m_height;
    initParams.frameRateNum = m_fps;
    initParams.frameRateDen = 1;
    initParams.enablePTD = 1;
    initParams.encodeConfig = &encConfig;
    initParams.maxEncodeWidth = m_width;
    initParams.maxEncodeHeight = m_height;

    std::cout << "[Stage 3 NVENC Param] frameRateNum=" << initParams.frameRateNum 
              << ", frameRateDen=" << initParams.frameRateDen 
              << ", gopLength=" << encConfig.gopLength
              << ", resolution=" << initParams.encodeWidth << "x" << initParams.encodeHeight 
              << ", bitrate=" << (encConfig.rcParams.averageBitRate / 1000000) << " Mbps" << std::endl;

    status = m_nvList.nvEncInitializeEncoder(m_hEncoder, &initParams);
    if (status != NV_ENC_SUCCESS) {
        std::cerr << "[NVENC] nvEncInitializeEncoder error: " << status << std::endl;
        return false;
    }

    // Pre-allocate bitstream output buffer (4MB)
    NV_ENC_CREATE_BITSTREAM_BUFFER createBuffer = { 0 };
    createBuffer.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
    createBuffer.size = 4 * 1024 * 1024;
    createBuffer.memoryHeap = NV_ENC_MEMORY_HEAP_SYSMEM_CACHED;

    status = m_nvList.nvEncCreateBitstreamBuffer(m_hEncoder, &createBuffer);
    if (status != NV_ENC_SUCCESS) {
        std::cerr << "[NVENC] nvEncCreateBitstreamBuffer error: " << status << std::endl;
        return false;
    }
    m_bitstreamBuffer = createBuffer.bitstreamBuffer;

    m_initialized = true;
    std::cout << "[NVENC] Ultra-low latency encoder initialized (" 
              << m_width << "x" << m_height << " @" << m_fps << "Hz, " 
              << m_bitrateMbps << " Mbps CBR)" << std::endl;
    return true;
}

bool NvEncoderD3D11::EncodeFrame(ID3D11Texture2D* pTexture, uint64_t frameIndex, std::vector<uint8_t>& outBitstream, bool& isKeyframe) {
    if (!m_initialized || !pTexture || !m_hEncoder) return false;

    // Fast-path: check if texture is already registered
    NV_ENC_REGISTERED_PTR regPtr = nullptr;
    auto it = m_registeredResources.find(pTexture);
    if (it != m_registeredResources.end()) {
        regPtr = it->second;
    } else {
        NV_ENC_REGISTER_RESOURCE regRes = { 0 };
        regRes.version = NV_ENC_REGISTER_RESOURCE_VER;
        regRes.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;
        regRes.resourceToRegister = pTexture;
        regRes.width = m_width;
        regRes.height = m_height;
        regRes.bufferFormat = NV_ENC_BUFFER_FORMAT_ARGB; // Direct3D11 BGRA/ARGB

        NVENCSTATUS status = m_nvList.nvEncRegisterResource(m_hEncoder, &regRes);
        if (status != NV_ENC_SUCCESS) {
            return false;
        }
        regPtr = regRes.registeredResource;
        m_registeredResources[pTexture] = regPtr;
    }

    NV_ENC_MAP_INPUT_RESOURCE mapRes = { 0 };
    mapRes.version = NV_ENC_MAP_INPUT_RESOURCE_VER;
    mapRes.registeredResource = regPtr;

    NVENCSTATUS status = m_nvList.nvEncMapInputResource(m_hEncoder, &mapRes);
    if (status != NV_ENC_SUCCESS) {
        return false;
    }

    // Submit picture
    NV_ENC_PIC_PARAMS picParams = { 0 };
    picParams.version = NV_ENC_PIC_PARAMS_VER;
    picParams.inputBuffer = mapRes.mappedResource;
    picParams.bufferFmt = NV_ENC_BUFFER_FORMAT_ARGB;
    picParams.inputWidth = m_width;
    picParams.inputHeight = m_height;
    picParams.outputBitstream = m_bitstreamBuffer;
    picParams.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;

    if (frameIndex == 0 || (frameIndex % (m_fps * 5) == 0)) {
        picParams.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;
    }

    status = m_nvList.nvEncEncodePicture(m_hEncoder, &picParams);

    // Lock bitstream to read encoded H.264
    if (status == NV_ENC_SUCCESS) {
        NV_ENC_LOCK_BITSTREAM lockParams = { 0 };
        lockParams.version = NV_ENC_LOCK_BITSTREAM_VER;
        lockParams.outputBitstream = m_bitstreamBuffer;
        lockParams.doNotWait = 0;

        status = m_nvList.nvEncLockBitstream(m_hEncoder, &lockParams);
        if (status == NV_ENC_SUCCESS) {
            uint8_t* ptr = (uint8_t*)lockParams.bitstreamBufferPtr;
            uint32_t size = lockParams.bitstreamSizeInBytes;

            outBitstream.assign(ptr, ptr + size);
            isKeyframe = (lockParams.pictureType == NV_ENC_PIC_TYPE_IDR);

            m_nvList.nvEncUnlockBitstream(m_hEncoder, m_bitstreamBuffer);
        }
    }

    m_nvList.nvEncUnmapInputResource(m_hEncoder, mapRes.mappedResource);
    return (status == NV_ENC_SUCCESS);
}

void NvEncoderD3D11::Destroy() {
    if (m_hEncoder) {
        for (auto& pair : m_registeredResources) {
            if (pair.second) {
                m_nvList.nvEncUnregisterResource(m_hEncoder, pair.second);
            }
        }
        m_registeredResources.clear();

        if (m_bitstreamBuffer) {
            m_nvList.nvEncDestroyBitstreamBuffer(m_hEncoder, m_bitstreamBuffer);
            m_bitstreamBuffer = NULL;
        }
        m_nvList.nvEncDestroyEncoder(m_hEncoder);
        m_hEncoder = NULL;
    }
    if (m_hNvEnc) {
        FreeLibrary(m_hNvEnc);
        m_hNvEnc = NULL;
    }
    m_initialized = false;
}

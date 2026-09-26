# Third-Party Notices & Licenses

ReDisplay incorporates or interfaces with the following third-party components:

---

## 1. Microsoft Windows-driver-samples (Indirect Display Driver Sample / IddCx)
- **Author**: Microsoft Corporation
- **Repository**: https://github.com/microsoft/Windows-driver-samples/tree/main/video/IndirectDisplay
- **License**: MS-PL
- **License text**: https://github.com/microsoft/Windows-driver-samples/blob/main/LICENSE
- **Notice**:
  ReDisplay is developed based on Microsoft Indirect Display Driver Sample.

---

## 2. NVIDIA NVENC / Video Codec SDK
- **Author**: NVIDIA Corporation
- **Website**: https://developer.nvidia.com/nvidia-video-codec-sdk
- **License text**: https://developer.nvidia.com/nvidia-video-codec-sdk
- **Notice**:
  ReDisplay encodes with NVIDIA NVENC.
  NVENC SDK is subject to NVIDIA proprietary terms and may only be used on NVIDIA GPUs.
  The NVENC header files is distributed under the MIT license.

---

## 3. Android ADB
- **Author**: Google LLC
- **Terms & Conditions**: https://developer.android.com/studio/terms
- **Notice**:
  ADB (Android Debug Bridge) is a component of the Android SDK Platform-Tools.
  ReDisplay forwards the video stream through an ADB tunnel, using the adb from the system PATH or an adb at a user-defined path.
  The copyright of the redistributed adb binary belongs to Google LLC and is subject to the Android SDK Terms.

---

## 4. Qualcomm MediaCodec
- **Author**: Qualcomm Technologies, Inc.
- **Notice**:
  ReDisplay Android uses the MediaCodec API to invoke Qualcomm hardware codecs.
  ReDisplay does not distribute any proprietary code or binaries from Qualcomm.
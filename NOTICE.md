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
  ReDisplay forwards the video stream through an ADB tunnel. The Windows app can use an existing Platform-Tools installation or download the official archive from Google on request. The release ZIP does not bundle ADB.

---

## 4. Qualcomm MediaCodec
- **Author**: Qualcomm Technologies, Inc.
- **Notice**:
  ReDisplay Android uses the MediaCodec API to invoke Qualcomm hardware codecs.
  ReDisplay does not distribute any proprietary code or binaries from Qualcomm.

---

## 5. Virtual Display Driver and NefCon

- The bundled MttVDD DLL, INF, and catalog are from the MikeTheTech / VirtualDrivers Virtual Display Driver family. The local INF identifies version 11.30.4.434 and Root\MttVDD. The upstream project publishes its source and MIT license.
  - https://github.com/VirtualDrivers/Virtual-Display-Driver
  - [License included with the project](Driver/LICENSE.MttVDD.txt) · https://github.com/VirtualDrivers/Virtual-Display-Driver/blob/24.12.24/LICENSE
- The bundled nefcon.exe is the Nefarius device management utility. Its upstream project publishes its source and MIT license.
  - https://github.com/nefarius/nefcon
  - [License included with the project](Driver/LICENSE.NefCon.txt) · https://github.com/nefarius/nefcon/blob/v1.20.0/LICENSE

## 6. Electron / Chromium

- The Windows package uses the Electron runtime pinned by GUI/package-lock.json. The bundled Electron LICENSE and LICENSES.chromium.html accompany the runtime. LICENSE.ReDisplay contains the application license.

## 7. Maple Mono

The English interface uses Maple Mono v7.8 Latin WOFF2 files from the Fontsource package @fontsource/maple-mono 5.3.0. The files use the SIL Open Font License 1.1. The license accompanies the fonts in GUI/assets/fonts.

- https://github.com/subframe7536/maple-font
- https://www.npmjs.com/package/@fontsource/maple-mono/v/5.3.0

## 8. JetBrains Mono

The Chinese interface uses JetBrains Mono for Latin characters and telemetry. The bundled Latin variable WOFF2 comes from @fontsource-variable/jetbrains-mono 5.3.0. The SIL Open Font License 1.1 accompanies it in GUI/assets/fonts/JetBrains-Mono-OFL.txt.

- https://github.com/JetBrains/JetBrainsMono
- https://www.npmjs.com/package/@fontsource-variable/jetbrains-mono/v/5.3.0

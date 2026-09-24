<p align="center">
  <b>ReDisplay</b>
</p>

<p align="center">
  <img src="GUI/assets/icon.png" width="128" height="128" alt="ReDisplay Logo" />
</p>

<p align="center">
  <b>轻巧易用，一线畅联，基于 IddCx + NVENC 的 Windows 低延迟高刷安卓副屏</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Windows %7C Android 11 +-blue?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/Host-C%2B%2B20%20%7C%20WGC%20%7C%20NVENC-success?style=flat-square" alt="Host" />
  <img src="https://img.shields.io/badge/Design-Material_Design_3-blueviolet?style=flat-square" alt="MD3" />
  <img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="License" />
</p>

ReDisplay 是一套开源、全链路硬件加速的超低延迟有线副屏拓展系统。基于高速 USB 3.2 Type-C ，将安卓设备无缝接入 Windows ，作为原生高刷新率副屏。

## ✨ 功能/特性

- **2K 144hz（或更高）**
- **硬件编码 < 4ms**
- **全链路 < 15ms**
- **参数随心调控**
- **实时状态遥测**
- **智能设备握手**
- **线材实时测速**
- **软件开箱即用**
- **MD3设计风格**
- **自动设备唤醒**
- **自动重连常驻**
- **多设备热插拔**

## 🚀 快速上手

### 1. 准备工作
- **Windows**: Windows 10/11 + NVIDIA 显卡 (需支持 NVENC)。
- **安卓设备**: Snapdragon + Android 11 +
- **连接线材**: USB 3.2 Gen 2 (或更高)
- **开启调试**: 在安卓端【设置】→【开发者选项】中开启【USB 调试】。

### 2. 启动服务
- 访问 Releases 下载 `ReDisplay-v1.0.0-Win64.zip`，双击运行 `ReDisplay.exe` 即可打开控制中心。
- 首次运行服务需以管理员身份安装驱动/为安卓设备推送APK

## 📐 低延迟架构


```
[ Windows Desktop ]
         |
         ▼
(Stage 1) IddCx → Windows DWM
         |
         ▼
(Stage 2) Windows.Graphics.Capture 3-Buffer
         |
         ▼
(Stage 3) NVIDIA NVENC 13.1 P1 
         |
         ▼
(Stage 4) Host TCP
         |  (USB 3.2 Gen 2 (+) ) Cable
         ▼
(Stage 5) Android ADB Tunnel TCP
         |
         ▼
(Stage 6) Qualcomm Snapdragon MediaCodec
         |
         ▼
(Stage 7) SurfaceFlinger
```

### 🔧 多层级优化

- **Windows.Graphics.Capture 3-Buffer Drop-to-Latest Pipeline**
- **NVENC Texture Registration Cache**
- **Qualcomm Codec 2.0**
- **高精度时钟调度**

### 📊 实测数据

Windows 11 + Android 16 + USB 3.2 Gen2 下：

| 项目 | 2.8K 120Hz | 2.8K 90Hz | 1080P 120Hz | 1080P 90Hz
|---|---|---|---|---|
| NVENC延迟 | 约 3 ms | 约 2.5 ms | 约 1.5 ms | 约 1 ms |
| 全链路延迟 | 约 12 ms | 约 11 ms | 约 9 ms | 约 8 ms |

> 基于 Nvidia RTX 5070Ti + Snapdragon 8 Gen 3

## 📄 开源许可证与声明

- ReDisplay 遵循 [MIT](LICENSE) 开源协议。

- 第三方组件遵循各自许可证：
  - NVIDIA NVENC
  - Android ADB
  - Windows.Graphics.Capture
  - Qualcomm MediaCodec
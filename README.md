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

## 🎉 版本更新 V1.1.0 ！

### 与 V1.0.0 相比：

- **更加敏捷**的投屏体验：+9% 呈现帧率，-56% 长帧占比，新的180FPS支持
- **更加易用**的用户体验：新的分页式布局，清晰易懂，上手方便快捷
- **更加轻快**的控制面板：应用优化，动效升级，灵动上线
- **更加优雅**的用户界面：中英随心切换，配色自由挑选

## ✨ 功能/特性

- **2.8K 180+ Hz**：“拉满”帧率画质
- **硬件编码 < 4ms**：针对硬件优化
- **全链路 ≈ 15ms**：灵动无感延迟
- **参数随心调控**：参数自主可控
- **实时状态遥测**：状态实时检测
- **智能设备握手**：即刻识别参数
- **线材实时测速**：可视链路速率
- **软件开箱即用**：解压即可运行
- **MD3 设计风格**：界面清爽统一
- **自动设备唤醒**：亮屏无需解锁
- **自动重连常驻**：断线自动恢复
- **多设备热插拔**：插拔即连即用
- **中英双语切换**：语言一键切换
- **多彩配色随心**：主题自由搭配

## 🚀 快速上手

### 1. 准备工作
- **操作系统**: Windows 10/11 + NVIDIA 显卡 (需支持 NVENC)
- **安卓设备**: Snapdragon + Android 11 +
- **开启调试**: 安卓端【设置】→【开发者选项】中开启【USB 调试】。
- **连接线材（建议）**: USB 3.2 Gen 2 (或更高)
> 需要 [Visual C++ x64 Redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist)。

### 2. 启动服务
- 访问 Releases 下载 `ReDisplay-v1.1.0-Win64.zip`，解压后双击运行 `ReDisplay.exe` 即可打开控制面板。
- 首次运行服务需要提升的管理员身份以**安装驱动/为安卓设备推送APK**

## 📊 实测数据

Windows 11 + Android 16 + USB 3.2 Gen2 下：

| 版本 / 分辨率 / 目标 FPS | 实际呈现 FPS | 呈现间隔 P95 | 间隔 > 12.5 ms | 图层帧就绪至呈现 P95 |
|:---:|:---:|:---:|:---:|:---:|
| V1.0.0 / 2.8K / 120FPS | 102.5 | 16.67 ms | 16.9% | 15.47 ms |
| **V1.1.0 / 2.8K / 120FPS** | **111.3** | 16.67 ms | **7.5%** | 15.91 ms |
| **V1.1.0 / 2.8K / 180FPS** | **174.2** | 8.61 ms | **4.6%** | 14.93 ms |

> 测试基于 Nvidia RTX 5070Ti + Snapdragon 8 Gen 3

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
(Stage 3) NVIDIA NVENC (P1) 
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

- **WGC 多缓冲管线 —— W.G.C 3-Buffer Drop-to-Latest Pipeline**
- **NVENC 纹理注册缓存 —— NVENC Texture Registration Cache**
- **高通编解码器 2.0 —— Qualcomm Codec 2.0**
- **高精度时钟调度 —— WaitableTimerExW**
- **聚合防粘包传输 —— W.S.A Send**
- **单调硬件 PTS —— SurfaceFlinger**

## 📄 开源许可证与声明

- ReDisplay 遵循 [MIT](LICENSE) 开源协议。
  - 第三方组件遵循各自许可证，详见 [NOTICE.md](NOTICE.md)。
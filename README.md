# ReDisplay: Ultra-Low Latency Wired Secondary Display System
> **极速 · 高刷 · 极低延迟 · 开源 Windows 有线副屏拓展系统**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%2011%20%7C%20Android%2010%2B-informational.svg)]()
[![C++20](https://img.shields.io/badge/Host-C%2B%2B20%20%7C%20WGC%20%7C%20NVENC-success.svg)]()
[![Electron](https://img.shields.io/badge/GUI-Electron%20%7C%20Material%20Design%203-blueviolet.svg)]()

ReDisplay 是一套开源、全链路硬件加速的超低延迟有线副屏拓展系统。它通过高速 USB 3.2 Type-C 链路（最高 10Gbps），将安卓平板（如三星 Galaxy Tab S9+ 等 120Hz AMOLED 屏幕设备）无缝接入 Windows 11 作为原生高刷新率副屏。

---

## ⚡ 核心性能指标与实测特性

- **全链路端到端超低延迟**: **8ms ~ 15ms**（远优于业界 25ms 阈值），NVENC 硬件编码耗时稳定在 **~3.4ms**。
- **点对点原生超清画质**: 原生点对点驱动输出（支持 $1752 \times 2800$ / $2800 \times 1752$），色彩锐利、文本清晰。
- **现代化 Material Design 3 桌面控制中心**:
  - **原生极简 Swiss Style 视觉语言**: 纯正深色模式，状态指示清晰直观，零冗余文本，无硬编码设备字符串。
  - **实时遥测仪表盘**: 实时 FPS 帧率、传输码率（Mbps）、NVENC 编码延迟（ms）、无损传输帧数与丢帧率。
  - **无终端黑框整合**: 纯原生桌面应用架构，无任何控制台黑框弹出；关闭即静默缩小至系统托盘，双击即唤醒。
  - **智能设备与副屏拓扑自适应**: 自动探测 USB 速率与握手协议，自动优选虚拟副屏驱动（IddCx）。
- **3 档标准化性能预设 (One-Click Profiles)**:
  - ⚡ **120Hz 极速电竞直通**: 120Hz · 60 Mbps · 丢帧保最新（≤10ms 极限响应）
  - 🎬 **120Hz 极致超清画质**: 120Hz · 85 Mbps · 丢帧保最新（2.8K 原生高保真渲染）
  - 🔋 **60Hz 节能办公模式**: 60Hz · 30 Mbps · 平滑优先（防掉帧低功耗）
  - 🛠️ **全自由自定义**: 刷新率（60/90/120/144Hz）、码率（20~100 Mbps 滑块自由无级调节）、Ring Buffer 模式。
- **全屏沉浸无遮挡体验**:
  - Android 端全屏沉浸无 UI，无系统状态栏与导航栏遮挡。
  - 适配摄像头挖孔（`LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS`）。
  - 黑屏状态下插线自动点亮唤醒（`setShowWhenLocked(true)`）。
- **坚如磐石的自动重连与常驻**:
  - 插拔数据线或锁屏恢复后，Host 自动探测重试并秒级重建视频流。
  - 支持多设备热插拔与一键下拉无缝切换。

---

## 📐 7 级低延迟流水线架构与技术实现

ReDisplay 严格遵循“单变量基准测量与逐级隔离优化”法则，构建了完整的 7 级低延迟直通管线：

```
[Windows OS Desktop / GPU Apps]
            │
    (Stage 1) Windows DWM 脏区渲染引擎 (120Hz+ 动态合成)
            ▼
    (Stage 2) Windows.Graphics.Capture 3-Buffer 环形无锁快照
            ▼
    (Stage 3) NVIDIA NVENC 13.1 P1 硬件超低延迟编码 (~3.4ms, 零重排)
            ▼
    (Stage 4) Host TCP 高性能套接字 (TCP_NODELAY, 4MB 发送缓冲)
            │  USB 3.2 Gen 2 高速物理链路 (实测 1037 MB/s)
            ▼
    (Stage 5) Android ADB Tunnel TCP 接收缓冲 (4MB 零等待)
            ▼
    (Stage 6) Qualcomm Snapdragon MediaCodec 硬件解码器 (零拷贝直推 Surface)
            ▼
    (Stage 7) SurfaceFlinger & One UI Choreographer (120.0 Hz 原生 VSync 刷新)
```

### 关键优化细节：
1. **Windows.Graphics.Capture 3-Buffer Drop-to-Latest Pipeline**:
   - 采用 `Direct3D11CaptureFramePool::CreateFreeThreaded` 创建 3 个缓冲槽，在 `FrameArrived` 事件中快速排空滞后帧并写入乒乓暂存纹理，杜绝帧池饥饿与卡顿。
2. **NVENC 纹理预注册缓存机制 (Texture Registration Cache)**:
   - 消除每帧调用 `nvEncRegisterResource` 和 `nvEncUnregisterResource` 的数百微秒开销，对 D3D11 纹理哈希缓存复用，将编码延迟从 16.6ms 压缩至 **~3.4ms**。
3. **高精度时钟调度**:
   - Windows 端主控进程调用 `timeBeginPeriod(1)` 强制激活 1ms 调度精度，根除 Windows 默认 15.6ms 时钟导致的 60fps 锁频问题。
4. **Qualcomm Codec 2.0 直通与 LTPO 锁频**:
   - 客户端解码器使用 `c2.qti.avc.decoder`，设置 `KEY_LOW_LATENCY=1`、`KEY_PRIORITY=0` 与 `KEY_OPERATING_RATE=1200` 超频时钟。
   - `DisplaySurfaceView` 设置 `Surface.setFrameRate(120.0f, Surface.FRAME_RATE_COMPATIBILITY_DEFAULT, Surface.CHANGE_FRAME_RATE_ALWAYS)`，防止 One UI LTPO VRR 机制在静态画面时将面板刷新率降至 30Hz。

---

## 📁 项目目录结构

```
ReDisplay/
├── Release/                      # 开箱即用完整便携发布目录 (GitHub Releases 产物)
│   ├── ReDisplay-Win64/          # 免安装便携运行目录 (独立运行，无需外部依赖)
│   │   ├── ReDisplay.exe         # 桌面客户端主程序 (无黑框原生 GUI，支持隐藏至托盘)
│   │   └── resources/
│   │       ├── bin/              # C++ 推流引擎 (ReDisplayHost.exe) 与 ADB 套件
│   │       ├── Client/           # Android 客户端 (ReDisplay.apk)
│   │       └── Driver/           # 虚拟副屏驱动 (IddCx Virtual Display Driver)
│   └── ReDisplay-v1.0.0-Win64.zip# 官方发布压缩包 (解压即用)
├── GUI/                          # Electron + Material Design 3 桌面控制中心源码
│   ├── assets/                   # 流体几何抽象化极简矢量与多尺寸 ICO / PNG 图标
│   ├── src/
│   │   ├── index.html            # 主界面结构 (MD3 极简设计)
│   │   ├── styles.css            # MD3 深色主题样式表
│   │   └── renderer.js           # 交互逻辑、档位切换与实时遥测监听
│   ├── main.js                   # Electron 主进程 (系统托盘、无黑框子进程调度)
│   ├── package.json              # 依赖管理与启动脚本 (npm start)
│   └── preload.js                # 安全 IPC 通信接口
├── Host/                         # Windows C++20 高性能推流核心源码
│   ├── src/
│   │   ├── main.cpp              # 主入口、参数解析与状态遥测循环
│   │   ├── capture.cpp           # WGC 3 缓冲无锁快照捕获管道 (支持 MinUpdateInterval 解锁 120Hz+)
│   │   ├── encoder.cpp           # NVENC 硬件超低延迟编码引擎
│   │   ├── display_manager.cpp   # 显示器拓扑枚举与虚拟副屏识别
│   │   └── adb.cpp               # ADB 进程管理与端口转发
│   ├── include/                  # 官方 SDK 头文件 (nvEncodeAPI.h)
│   ├── build.bat                 # MSVC 自动化编译脚本
│   └── ReDisplayHost.exe         # 编译产物
├── Client/                       # Android 硬件解码客户端
│   ├── app/src/main/             # Java/Android 源码
│   └── ReDisplay.apk             # 编译签名就绪的客户端安装包
├── Driver/                       # 虚拟显示器驱动 (IddCx Virtual Display Driver)
│   ├── files/                    # 驱动核心文件 (MttVDD.dll, MttVDD.inf, mttvdd.cat)
│   ├── install_driver.bat        # 驱动一键安装脚本 (支持管理员提权)
│   └── uninstall_driver.bat      # 驱动卸载脚本
├── README.md                     # 规范的中英双语 GitHub 项目说明文档
└── .gitignore                    # 规范的 Git 忽略规则
```

---

## 🚀 快速上手与操作指南

### 1. 准备工作
- **Windows 主机**: Windows 10 (2004+) 或 Windows 11，配备 NVIDIA 显卡（支持 NVENC）。
- **安卓设备**: Android 10+（推荐支持 120Hz 高刷屏的平板或手机）。
- **连接线材**: 建议使用优质 USB 3.0 / USB 3.2 Type-C 数据线连接至主机 USB 3.2 蓝色/红色或 Type-C 接口。
- **开启调试**: 在安卓端【设置】→【开发者选项】中开启【USB 调试】。

### 2. 启动服务
- **普通用户**: 访问 Releases 下载 `ReDisplay-v1.0.0-Win64.zip`（或打开 `Release/ReDisplay-Win64/`），双击运行 `ReDisplay.exe` 即可打开控制中心。
- **开发者**: 进入 `GUI/` 目录运行 `npm start` 即可启动开发调试模式。
1. 控制中心将自动检测已连接的安卓设备并枚举显示器拓扑。
2. 若设备尚未安装客户端，软件会提示并支持一键静默推送安装 `ReDisplay.apk`。
3. 选择需要的性能档位（默认推荐 **⚡ 极速直通**）。
4. 点击 **【启动副屏服务】** 按钮，副屏将即刻点亮！

### 3. 平板端交互手势
- **双击屏幕**: 在画面缩放模式之间循环切换：
  - `FIT`: 保持宽高比居中显示（两边留黑边，保证 100% 完整显示）。
  - `FILL`: 裁剪铺满屏幕。
  - `STRETCH`: 强制拉伸至全屏。
- **单击屏幕**: 唤出/隐藏微型半透明网络与性能统计悬浮窗。

---

## 🛠️ 开发者编译构建指南

### 1. 编译 Windows Host C++ 核心
环境要求: Visual Studio 2022 / 2025 (MSVC v143+)，Windows 10/11 SDK。
```cmd
cd Host
build.bat
```
输出路径: `Host\ReDisplayHost.exe`。

### 2. 运行 GUI 开发环境
环境要求: Node.js 18+。
```cmd
cd GUI
npm start
```

---

## 📄 开源许可证
本项目采用 [MIT License](LICENSE) 开源许可证。
欢迎提交 Issue 和 Pull Request 共同完善！

# 从源码构建与打包

在 Windows x64 的 PowerShell 中进入仓库根目录。需要 MSVC x64 C++20 工具链、包含 WGC MinUpdateInterval 的 Windows SDK（已验证 10.0.26100.0）、Node.js 22.12 或更新版本及 npm、Android SDK Platform 34、Build Tools 34.0.0 和 JDK 17。运行时请另行安装 [Android SDK Platform-Tools](https://developer.android.com/tools/releases/platform-tools)。

## 构建和运行

先设置 ANDROID_HOME 与 JAVA_HOME，然后执行：

    npm --prefix GUI ci
    npm --prefix GUI exec --no -- install-electron
    .\Host\build.bat .\scratch\release-v120\bin
    .\Client\build.ps1 -OutputDir .\scratch\release-v120\Client
    npm --prefix GUI start

Electron 二进制安装需要访问 Electron 的 GitHub 下载，或使用已有本地缓存。参见 [Electron 安装说明](https://www.electronjs.org/docs/latest/tutorial/installation#binary-download-step)。

Android 构建也接受 -AndroidSdk 和 -Jdk。若用 JDK 21 运行旧版 D8，可用 -Javac 指定 JDK 8 的 javac.exe。ADB 可通过 Android SDK 路径、PATH 或 REDISPLAY_ADB 指定。

## 打包 Windows x64

关闭开发版后执行：

    .\Release\package.ps1

脚本默认从 scratch\release-v120 读取 Host 和 APK，在 Release 下生成 ReDisplay-v1.2.0-Win64 和同名 ZIP。-BuildRoot 指定其他构建目录，-OutputRoot 指定另一输出目录。GitHub 发布时用 v1.2.0 标签，并上传便携 ZIP 和它的 SHA256SUMS.txt。GitHub 自动附带的 Source code 压缩包用于获取源码。

## 签名

- 未提供签名参数时，Android 构建在本机构建目录生成测试密钥。要使用自己的签名，向 Client/build.ps1 提供 -Keystore、-KeyAlias，在当前环境设置 REDISPLAY_KEYSTORE_PASSWORD。若密钥密码不同，再设置 REDISPLAY_KEY_PASSWORD。签名文件与密码留在本机。
- V1.2.0 沿用 Android 包名 com.redisplay.client.v120demo。覆盖安装要求签名一致。此次便携包使用原位升级验证过的 APK。换用另一签名时，原安装需要先卸载。
- 核对 GUI/package.json、Host --version、APK versionName 和 Release 文件名，确认都是 1.2.0。发行包内有 [第三方组件说明](../NOTICE.md) 及随包许可。

## 独立回归测试

- 在仓库根目录运行 node Tests/telemetry_test.cjs，检查图层呈现和端到端时间戳统计。
- 在 MSVC x64 开发者命令行以 cl /EHsc /std:c++20 /DNOMINMAX Tests\transport_test.cpp /link ws2_32.lib 构建后执行 transport_test.exe，检查套接字短写与队列 IDR 恢复。

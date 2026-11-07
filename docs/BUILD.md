# 从源码构建与打包

在仓库根目录打开 PowerShell。需要 x64 MSVC C++20 工具链与含 WGC `MinUpdateInterval` 的 Windows SDK（已用 10.0.26100.0 构建），Node.js/npm，以及 Android SDK Platform 34、Build Tools 34.0.0 和 JDK 17。

## 构建和运行

1. 在 `GUI` 中执行 `npm ci`，安装锁定版本的 Electron 和 `rcedit`。
2. 从根目录执行 `.\Host\build.bat`。默认生成 `scratch\demo\bin\ReDisplayHost.exe`。
3. 设置 `ANDROID_HOME` 与 `JAVA_HOME`，执行 `.\Client\build.ps1`。也可传入 `-AndroidSdk` 与 `-Jdk`。APK 输出到 `scratch\demo\Client`。如果用 JDK 21 运行旧版 D8，可用 `-Javac` 指定 JDK 8 的 `javac.exe`。已验证这个组合。
4. 使用 `npm --prefix GUI start` 运行开发控制中心。通过系统 `PATH`、Android SDK 的 `platform-tools` 或 `REDISPLAY_ADB` 指定 ADB。

## 打包 Windows x64

```powershell
.\Release\package.ps1
```

打包器从锁定的 Electron 运行时、现有驱动文件与新构建的 Host/APK 组装 `Release\ReDisplay-v1.1.0-Win64` 及同名 ZIP。可用 `-AdbDirectory 'C:\Android\platform-tools'` 明确提供要随包分发的 ADB 文件，不传该参数时从系统查找 ADB。若同名输出已存在，用 `-OutputRoot` 指向新的暂存目录。

## 签名与发布核对

- 本地默认 APK 使用 `scratch` 内的测试密钥。正式发布前，用自己的发行密钥重建 APK。通过 `-Keystore`、`-KeyAlias` 传入路径和别名，设置 `REDISPLAY_KEYSTORE_PASSWORD`，若密钥密码不同再设置 `REDISPLAY_KEY_PASSWORD`。密钥和密码保留在本地。
- 发行 APK 沿用包名 `com.redisplay.client.demo`。同包名且签名一致可以覆盖升级。换成发行证书时，旧测试 APK 需先从 Android 卸载。
- 核对 `GUI/package.json`、Host `--version`、APK `versionName` 和 ZIP 文件名，确认都为待发布版本。检查 [第三方组件说明](../NOTICE.md)，保留实际随包组件的许可证和来源。ADB 从 [Android SDK Platform-Tools](https://developer.android.com/tools/releases/platform-tools) 获取。
- 删除 README 中临时的「审阅标记」提示后再提交。GitHub Release 使用 `v1.1.0` 标签、同名 ZIP 和 [更新日志](../CHANGELOG.md) 中对应条目。`Release/Archive/` 与 `scratch/` 属于本机整理和测试目录。

## 回归验证

- `Tests/transport_test.cpp` 在 MSVC x64 工具链下以 C++20 编译并链接 `ws2_32.lib`，覆盖短写和发送队列 IDR 恢复。
- `Tests/stream_bench.py` 使用同一运动场景记录 Host 与 Android 日志。通过 `--serial` 固定设备，`--fps 180` 选择高帧率档，`--present` 采集 Android 图层呈现时间戳。结束后可将虚拟显示器恢复到原配置。

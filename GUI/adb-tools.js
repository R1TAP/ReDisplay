const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

const platformToolsPage = 'https://developer.android.com/tools/releases/platform-tools';
const platformToolsZip = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip';
const adbFiles = ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll'];
const archiveFiles = [...adbFiles, 'NOTICE.txt', 'source.properties'];
const downloadLimit = 64 * 1024 * 1024;

function isFile(file) {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

function hasAdbFiles(exe) {
    return Boolean(exe && path.basename(exe).toLowerCase() === 'adb.exe' &&
        adbFiles.every(file => isFile(path.join(path.dirname(exe), file))));
}

function findAdb({ appDirectory, resourcesDirectory, managedDirectory, selectedPath, env = process.env }) {
    const sdkRoots = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Android', 'Sdk')];
    const candidates = [
        selectedPath,
        env.REDISPLAY_ADB,
        path.join(appDirectory, 'platform-tools', 'adb.exe'),
        path.join(appDirectory, '..', 'platform-tools', 'adb.exe'),
        path.join(resourcesDirectory, 'bin', 'adb.exe'),
        path.join(managedDirectory, 'adb.exe'),
        ...sdkRoots.filter(Boolean).map(root => path.join(root, 'platform-tools', 'adb.exe')),
        path.join(appDirectory, 'Release', 'Archive', 'ReDisplay-Win64', 'resources', 'bin', 'adb.exe'),
        'C:\\Program Files\\QtScrcpy-win-x64-v3.2.0\\adb.exe',
        ...(env.PATH || '').split(path.delimiter).map(dir => dir.trim().replace(/^"(.*)"$/, '$1'))
            .filter(Boolean).map(dir => path.join(dir, 'adb.exe'))
    ];
    return candidates.find(candidate => candidate && path.isAbsolute(candidate) && hasAdbFiles(candidate)) || '';
}

function resolveAdbFolder(folder) {
    return [folder, path.join(folder, 'platform-tools')].map(dir => path.join(dir, 'adb.exe')).find(hasAdbFiles) || '';
}

async function validateAdb(exe) {
    if (!hasAdbFiles(exe)) return false;
    try {
        const { stdout } = await run(exe, ['version'], { windowsHide: true, timeout: 5000 });
        return /^Android Debug Bridge version \d+/m.test(stdout);
    } catch {
        return false;
    }
}

async function installPlatformTools(target) {
    const existing = path.join(target, 'adb.exe');
    if (await validateAdb(existing)) return existing;

    const parent = path.dirname(target);
    await fs.promises.mkdir(parent, { recursive: true });
    const stage = await fs.promises.mkdtemp(path.join(parent, 'download-'));
    try {
        const archive = path.join(stage, 'platform-tools.zip');
        const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
        const curl = path.join(system32, 'curl.exe');
        await run(curl, ['--disable', '--fail', '--silent', '--show-error', '--proto', '=https', '--connect-timeout', '10',
            '--max-time', '60', '--max-filesize', String(downloadLimit), '--output', archive, platformToolsZip],
            { windowsHide: true, timeout: 65_000 });
        if ((await fs.promises.stat(archive)).size > downloadLimit) throw new Error('ZIP exceeds 64 MiB');

        const tar = path.join(system32, 'tar.exe');
        await run(tar, ['-xf', archive, '-C', stage, ...archiveFiles.map(file => 'platform-tools/' + file)],
            { windowsHide: true, timeout: 15_000 });
        const extracted = path.join(stage, 'platform-tools');
        for (const file of archiveFiles) {
            if (!(await fs.promises.lstat(path.join(extracted, file))).isFile()) throw new Error('Invalid Platform-Tools ZIP');
        }
        if (!await validateAdb(path.join(extracted, 'adb.exe'))) throw new Error('adb version failed');

        // Publish the complete, validated directory in one rename. Keep an earlier copy until then.
        const backup = path.join(stage, 'previous');
        try {
            await fs.promises.rename(target, backup);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        try {
            await fs.promises.rename(extracted, target);
        } catch (error) {
            if (fs.existsSync(backup)) {
                try {
                    await fs.promises.rename(backup, target);
                } catch {
                    // Leave the backup in place if Windows still has the directory locked.
                    throw new Error(error.message + ' · ' + backup);
                }
            }
            throw error;
        }
        return existing;
    } finally {
        if (!(fs.existsSync(path.join(stage, 'previous')) && !fs.existsSync(target))) {
            await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => {});
        }
    }
}

module.exports = { findAdb, resolveAdbFolder, validateAdb, installPlatformTools, platformToolsPage };

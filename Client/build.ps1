param(
    [string]$AndroidSdk = $env:ANDROID_HOME,
    [string]$Jdk = $env:JAVA_HOME,
    [string]$Javac,
    [string]$Keystore,
    [string]$KeyAlias,
    [string]$OutputDir = (Join-Path $PSScriptRoot '..\scratch\demo\Client')
)

$ErrorActionPreference = 'Stop'
if (!$AndroidSdk) { $AndroidSdk = $env:ANDROID_SDK_ROOT }
if (!$AndroidSdk) { throw 'Set ANDROID_HOME or pass -AndroidSdk.' }
if (!$Jdk) { throw 'Set JAVA_HOME or pass -Jdk. Use JDK 17 for Build Tools 34.' }
$AndroidSdk = (Resolve-Path -LiteralPath $AndroidSdk).Path
$Jdk = (Resolve-Path -LiteralPath $Jdk).Path
$tools = Join-Path $AndroidSdk 'build-tools\34.0.0'
$androidJar = Join-Path $AndroidSdk 'platforms\android-34\android.jar'
$source = Join-Path $PSScriptRoot 'app\src\main'
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$OutputDir = (Resolve-Path -LiteralPath $OutputDir).Path
$work = Join-Path $OutputDir 'build'
$classes = Join-Path $work 'classes'
New-Item -ItemType Directory -Force -Path $classes | Out-Null
Get-ChildItem -LiteralPath $classes -Recurse -File -Filter '*.class' | Remove-Item

function Invoke-Tool($program, $arguments) {
    & $program @arguments
    if ($LASTEXITCODE -ne 0) { throw "$program failed ($LASTEXITCODE)" }
}

$previousJdk = $env:JAVA_HOME
$env:JAVA_HOME = $Jdk
if ($Keystore) { $Keystore = (Resolve-Path -LiteralPath $Keystore).Path }
Push-Location $work
try {
    Invoke-Tool "$tools\aapt2.exe" @('compile', '--dir', "$source\res", '-o', 'res.zip')
    Invoke-Tool "$tools\aapt2.exe" @('link', '-I', $androidJar, '--manifest', "$source\AndroidManifest.xml",
        '--rename-manifest-package', 'com.redisplay.client.demo', '--version-code', '1010000',
        '--version-name', '1.1.0', '--java', 'generated', '--custom-package', 'com.redisplay.client', '-o', 'resources.apk', 'res.zip')
    $sources = @(Get-ChildItem "$source\java" -Filter '*.java' -Recurse | Where-Object Name -ne 'R.java' | ForEach-Object FullName)
    $sources += (Join-Path $work 'generated\com\redisplay\client\R.java')
    if (!$Javac) { $Javac = "$Jdk\bin\javac.exe" }
    Invoke-Tool $Javac (@('-source', '8', '-target', '8', '-encoding', 'UTF-8',
        '-classpath', $androidJar, '-d', $classes) + $sources)
    Invoke-Tool "$Jdk\bin\jar.exe" @('cf', 'client.jar', '-C', $classes, '.')
    Invoke-Tool "$Jdk\bin\java.exe" @('-cp', "$tools\lib\d8.jar", 'com.android.tools.r8.D8',
        '--lib', $androidJar, '--min-api', '26', '--output', $work, 'client.jar')
    Invoke-Tool "$tools\aapt.exe" @('add', 'resources.apk', 'classes.dex')
    Invoke-Tool "$tools\zipalign.exe" @('-f', '4', 'resources.apk', 'aligned.apk')

    if ($Keystore) {
        if (!$KeyAlias -or !$env:REDISPLAY_KEYSTORE_PASSWORD) {
            throw 'Supply -KeyAlias and set REDISPLAY_KEYSTORE_PASSWORD for release signing.'
        }
        $signing = @('--ks', $Keystore, '--ks-key-alias', $KeyAlias, '--ks-pass', 'env:REDISPLAY_KEYSTORE_PASSWORD')
        if ($env:REDISPLAY_KEY_PASSWORD) { $signing += @('--key-pass', 'env:REDISPLAY_KEY_PASSWORD') }
    } else {
        $Keystore = Join-Path $work 'demo-debug.keystore'
        if (!(Test-Path -LiteralPath $Keystore)) {
            Invoke-Tool "$Jdk\bin\keytool.exe" @('-genkeypair', '-keystore', $Keystore, '-storepass', 'android',
                '-keypass', 'android', '-alias', 'redisplay-demo', '-keyalg', 'RSA', '-keysize', '2048',
                '-validity', '10000', '-dname', 'CN=ReDisplay Local Demo')
        }
        $signing = @('--ks', $Keystore, '--ks-key-alias', 'redisplay-demo', '--ks-pass', 'pass:android')
    }
    $apk = Join-Path $OutputDir 'ReDisplay.apk'
    Invoke-Tool "$Jdk\bin\java.exe" (@('-jar', "$tools\lib\apksigner.jar", 'sign') + $signing + @('--out', $apk, 'aligned.apk'))
    Invoke-Tool "$Jdk\bin\java.exe" @('-jar', "$tools\lib\apksigner.jar", 'verify', $apk)
    Write-Host "Built $apk"
} finally {
    Pop-Location
    $env:JAVA_HOME = $previousJdk
}

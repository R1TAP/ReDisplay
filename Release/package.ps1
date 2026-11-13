param(
    [string]$BuildRoot = (Join-Path $PSScriptRoot '..\scratch\release-v120'),
    [string]$OutputRoot = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$BuildRoot = (Resolve-Path -LiteralPath $BuildRoot).Path
$electron = Join-Path $root 'GUI\node_modules\electron\dist'
$rcedit = Join-Path $root 'GUI\node_modules\rcedit\bin\rcedit-x64.exe'
$hostExe = Join-Path $BuildRoot 'bin\ReDisplayHost.exe'
$apk = Join-Path $BuildRoot 'Client\ReDisplay.apk'
$package = Get-Content -Raw -LiteralPath "$root\GUI\package.json" | ConvertFrom-Json
$version = $package.version
if ($version -notmatch '^(\d+\.\d+\.\d+)(?:-demo\.(\d+))?$') { throw 'Expected x.y.z or x.y.z-demo.n.' }
$revision = if ($Matches[2]) { $Matches[2] } else { '0' }
$releaseVersion = $Matches[1]
$fileVersion = "$releaseVersion.$revision"

foreach ($file in @("$electron\electron.exe", $rcedit, $hostExe, $apk)) {
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing $file" }
}
$hostVersion = (& $hostExe --version).Trim()
$expectedHost = if ($package.hostVersion) { $package.hostVersion } else { $version }
if ($hostVersion -ne "ReDisplay Host $expectedHost") { throw "Expected Host $expectedHost for package $version." }

New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
$OutputRoot = (Resolve-Path -LiteralPath $OutputRoot).Path
$name = "ReDisplay-v$version-Win64"
$target = Join-Path $OutputRoot $name
$zip = "$target.zip"
if ((Test-Path -LiteralPath $target) -or (Test-Path -LiteralPath $zip)) {
    throw "Output already exists. Use -OutputRoot to stage a new copy."
}

New-Item -ItemType Directory -Force -Path "$target\resources\app\assets", "$target\resources\bin", "$target\resources\Client" | Out-Null
Get-ChildItem -LiteralPath $electron | Where-Object Name -notin 'electron.exe', 'resources' |
    Copy-Item -Destination $target -Recurse
Copy-Item -LiteralPath "$electron\electron.exe" -Destination "$target\ReDisplay.exe"

Copy-Item -LiteralPath $hostExe -Destination "$target\resources\bin"
Copy-Item -LiteralPath "$root\Host\config.default.ini" -Destination "$target\resources\bin\config.ini"
Copy-Item -LiteralPath $apk -Destination "$target\resources\Client"
Copy-Item -LiteralPath "$root\Driver" -Destination "$target\resources" -Recurse
Copy-Item -LiteralPath "$root\GUI\main.js", "$root\GUI\preload.js", "$root\GUI\i18n.js", "$root\GUI\profiles.js", "$root\GUI\telemetry.js",
    "$root\GUI\package.json", "$root\GUI\src" -Destination "$target\resources\app" -Recurse
foreach ($asset in 'icon.ico', 'icon.png', 'tray.ico', 'tray.png') {
    Copy-Item -LiteralPath "$root\GUI\assets\$asset" -Destination "$target\resources\app\assets"
}
Copy-Item -LiteralPath "$root\GUI\assets\fonts" -Destination "$target\resources\app\assets" -Recurse
Copy-Item -LiteralPath "$root\LICENSE" -Destination "$target\LICENSE.ReDisplay"
Copy-Item -LiteralPath "$root\NOTICE.md", "$root\CHANGELOG.md" -Destination $target
$releaseNotes = Join-Path $root "docs\V$releaseVersion-RELEASE.md"
if (Test-Path -LiteralPath $releaseNotes -PathType Leaf) {
    New-Item -ItemType Directory -Force -Path "$target\docs" | Out-Null
    Copy-Item -LiteralPath $releaseNotes -Destination "$target\docs"
    Copy-Item -LiteralPath "$root\docs\BUILD.md" -Destination "$target\docs"
}
$verification = Join-Path $root "docs\V$releaseVersion-VERIFICATION.md"
if (Test-Path -LiteralPath $verification -PathType Leaf) {
    New-Item -ItemType Directory -Force -Path "$target\docs" | Out-Null
    Copy-Item -LiteralPath $verification -Destination "$target\docs"
}

$uiNotes = Join-Path $root "docs\V$releaseVersion-UI.md"
if (Test-Path -LiteralPath $uiNotes -PathType Leaf) {
    New-Item -ItemType Directory -Force -Path "$target\docs" | Out-Null
    Copy-Item -LiteralPath $uiNotes -Destination "$target\docs"
    Copy-Item -LiteralPath "$root\docs\ui-preview" -Destination "$target\docs" -Recurse
}

$metadata = @('--set-icon', "$root\GUI\assets\icon.ico", '--set-file-version', $fileVersion,
    '--set-product-version', $fileVersion, '--set-version-string', 'ProductName', 'ReDisplay',
    '--set-version-string', 'FileDescription', "ReDisplay $version")
& $rcedit "$target\ReDisplay.exe" @metadata
if ($LASTEXITCODE -ne 0) { throw "rcedit failed ($LASTEXITCODE)" }
& tar.exe -a -cf $zip -C $OutputRoot $name
if ($LASTEXITCODE -ne 0) { throw "ZIP packaging failed ($LASTEXITCODE)" }
Write-Host "Built $zip"

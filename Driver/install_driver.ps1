param(
    [ValidateRange(0, 4096)][int]$DeviceWidth = 0,
    [ValidateRange(0, 4096)][int]$DeviceHeight = 0,
    [switch]$UpdateOnly
)

$ErrorActionPreference = 'Stop'
if (($DeviceWidth -eq 0) -ne ($DeviceHeight -eq 0) -or $DeviceWidth % 2 -or $DeviceHeight % 2 -or
    ($UpdateOnly -and (!$DeviceWidth -or !$DeviceHeight))) {
    throw 'Provide both even device dimensions or omit both for a standard installation.'
}

$utility = Join-Path $PSScriptRoot 'nefcon.exe'
$inf = Join-Path $PSScriptRoot 'files\MttVDD.inf'
$settingsDirectory = Join-Path $env:SystemDrive 'VirtualDisplayDriver'
$settings = Join-Path $settingsDirectory 'vdd_settings.xml'

function Get-VddDevices {
    @(Get-CimInstance Win32_PnPEntity -Filter "PNPClass='Display'" |
        Where-Object { $_.Present -and $_.HardwareID -contains 'Root\MttVDD' })
}

function Wait-VddStarted {
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        $device = Get-VddDevices | Where-Object ConfigManagerErrorCode -eq 0 | Select-Object -First 1
        if ($device) { return }
        Start-Sleep -Milliseconds 500
    }
    throw 'The MttVDD device did not start.'
}

function Save-VddSettings([string]$path, [string]$template, [int]$width, [int]$height) {
    $existing = Test-Path -LiteralPath $path -PathType Leaf
    $xml = [Xml.XmlDocument]::new()
    $xml.PreserveWhitespace = $true
    if ($existing) { $xml.Load($path) } else { $xml.Load($template) }
    $root = $xml.SelectSingleNode('/vdd_settings')
    if (!$root) { throw 'The MttVDD settings XML has an unexpected root element.' }
    $changed = !$existing
    $global = $root.SelectSingleNode('global')
    if (!$global) {
        $global = $xml.CreateElement('global')
        [void]$root.AppendChild($global)
    }
    if (!$global.SelectSingleNode('g_refresh_rate[normalize-space(.)="180"]')) {
        Add-VddXmlElement $xml $global 'g_refresh_rate' '180'
        $changed = $true
    }
    if ($width -and $height) {
        $resolutions = $root.SelectSingleNode('resolutions')
        if (!$resolutions) {
            $resolutions = $xml.CreateElement('resolutions')
            [void]$root.AppendChild($resolutions)
        }
        foreach ($size in @(@{ width=$width; height=$height }, @{ width=$height; height=$width })) {
            $w = $size.width
            $h = $size.height
            if ($resolutions.SelectSingleNode("resolution[width=$w and height=$h and refresh_rate>0]")) { continue }
            $mode = $xml.CreateElement('resolution')
            foreach ($key in 'width', 'height', 'refresh_rate') {
                $node = $xml.CreateElement($key)
                $node.InnerText = if ($key -eq 'refresh_rate') { '60' } else { [string]$size[$key] }
                [void]$mode.AppendChild($node)
            }
            Add-VddXmlElement $xml $resolutions 'resolution' $mode
            $changed = $true
        }
    }
    if (!$changed) { return $false }
    $temp = "$path.$([Guid]::NewGuid()).tmp"
    try {
        $xml.Save($temp)
        if ($existing) {
            [IO.File]::Replace($temp, $path, "$temp.bak")
            Remove-Item -LiteralPath "$temp.bak" -ErrorAction SilentlyContinue
        }
        else { [IO.File]::Move($temp, $path) }
    } finally {
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp }
    }
    return $true
}

function Add-VddXmlElement($xml, $parent, [string]$name, $value) {
    $node = if ($value -is [Xml.XmlElement]) { $value } else {
        $element = $xml.CreateElement($name)
        $element.InnerText = $value
        $element
    }
    if ($parent.LastChild -is [Xml.XmlWhitespace]) {
        [void]$parent.InsertBefore($xml.CreateWhitespace([Environment]::NewLine + '        '), $parent.LastChild)
        [void]$parent.InsertBefore($node, $parent.LastChild)
    } else {
        [void]$parent.AppendChild($node)
    }
}

$devices = @(Get-VddDevices)
if ($UpdateOnly -and !($devices | Where-Object ConfigManagerErrorCode -eq 0)) {
    throw 'Install and enable MttVDD before adding a device resolution.'
}
if (!$UpdateOnly -and (!(Test-Path -LiteralPath $utility -PathType Leaf) -or !(Test-Path -LiteralPath $inf -PathType Leaf))) {
    throw 'The MttVDD installation files are incomplete.'
}

$original = if (Test-Path -LiteralPath $settings -PathType Leaf) { ,([IO.File]::ReadAllBytes($settings)) } else { $null }
$changed = $false
try {
    New-Item -ItemType Directory -Path $settingsDirectory -Force | Out-Null
    $changed = Save-VddSettings $settings (Join-Path $PSScriptRoot 'vdd_settings.xml') $DeviceWidth $DeviceHeight
    if (!$UpdateOnly) {
        & pnputil.exe /add-driver $inf
        if ($LASTEXITCODE) { throw "MttVDD staging exited with code $LASTEXITCODE." }

        & $utility --create-device-node --hardware-id 'Root\MttVDD' --class-name 'Display' --class-guid '{4d36e968-e325-11ce-bfc1-08002be10318}' --no-duplicates
        if ($LASTEXITCODE) { throw "MttVDD device creation exited with code $LASTEXITCODE." }

        & pnputil.exe /add-driver $inf /install
        if ($LASTEXITCODE) { throw "MttVDD binding exited with code $LASTEXITCODE." }
    }
    if ($changed) {
        foreach ($device in $devices) {
            & pnputil.exe /restart-device $device.PNPDeviceID
            if ($LASTEXITCODE) { throw "MttVDD restart exited with code $LASTEXITCODE." }
        }
    }
    Wait-VddStarted
} catch {
    try {
        if (!$devices.Count -and (Get-VddDevices).Count) {
            & $utility --remove-device-node --hardware-id 'Root\MttVDD' --class-guid '{4d36e968-e325-11ce-bfc1-08002be10318}'
            if ($LASTEXITCODE) { throw "MttVDD rollback exited with code $LASTEXITCODE." }
        }
        if ($changed) {
            if ($null -ne $original) { [IO.File]::WriteAllBytes($settings, $original) }
            else { Remove-Item -LiteralPath $settings }
            foreach ($device in $devices) { & pnputil.exe /restart-device $device.PNPDeviceID }
        }
    } catch {
        Write-Warning $_.Exception.Message
    }
    throw
}

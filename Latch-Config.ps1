$ErrorActionPreference = "Stop"

$script:LatchConfigRoot = if ($PSScriptRoot) {
    $PSScriptRoot
} else {
    Split-Path -Parent $PSCommandPath
}

function Get-LatchLocalConfig {
    $ConfigPath = Join-Path $script:LatchConfigRoot "data\local-settings.json"
    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        return [PSCustomObject]@{}
    }

    Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
}

function Resolve-LatchHostAddress {
    param([string]$HostAddress = "")

    if ($HostAddress) {
        return $HostAddress
    }
    if ($env:LATCH_HOST_ADDRESS) {
        return $env:LATCH_HOST_ADDRESS
    }

    $Config = Get-LatchLocalConfig
    if ($Config.windowsTailscaleIp) {
        return $Config.windowsTailscaleIp
    }

    throw "Missing Latch host address. Set -HostAddress, LATCH_HOST_ADDRESS, or data\local-settings.json."
}

function Resolve-LatchPort {
    param([string]$Port = "")

    if ($Port) {
        return $Port
    }
    if ($env:LATCH_PORT) {
        return $env:LATCH_PORT
    }

    $Config = Get-LatchLocalConfig
    if ($Config.port) {
        return [string]$Config.port
    }

    return "8787"
}

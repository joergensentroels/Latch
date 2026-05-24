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

function Save-LatchLocalConfig {
    param([Parameter(Mandatory = $true)]$Config)

    $ConfigPath = Join-Path $script:LatchConfigRoot "data\local-settings.json"
    $ConfigDir = Split-Path -Parent $ConfigPath
    New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
    $Config | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
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

function Resolve-TailscaleCli {
    $Tailscale = Get-Command tailscale -ErrorAction SilentlyContinue
    if (-not $Tailscale -and (Test-Path -LiteralPath "C:\Program Files\Tailscale\tailscale.exe")) {
        $Tailscale = Get-Item -LiteralPath "C:\Program Files\Tailscale\tailscale.exe"
    }

    if (-not $Tailscale) {
        throw "Tailscale CLI was not found. Install and sign in to Tailscale first."
    }

    return $Tailscale.FullName
}

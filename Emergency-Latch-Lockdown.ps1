param(
    [switch]$StopServing,

    [switch]$NoRestart
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$AuthPath = Join-Path $Root "data\auth.json"
$BackupDir = Join-Path $Root "data\backups"

function New-LatchToken {
    param([Parameter(Mandatory = $true)][string]$Prefix)

    $Bytes = New-Object byte[] 24
    $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $Rng.GetBytes($Bytes)
    } finally {
        $Rng.Dispose()
    }

    $Token = [Convert]::ToBase64String($Bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
    return "$Prefix`_$Token"
}

if (-not (Test-Path -LiteralPath $AuthPath)) {
    throw "Missing data\auth.json. Start Latch once before rotating keys."
}

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$BackupPath = Join-Path $BackupDir "auth-before-emergency-lockdown-$Stamp.json"
Copy-Item -LiteralPath $AuthPath -Destination $BackupPath

$Now = (Get-Date).ToUniversalTime().ToString("o")
$NewAuth = [ordered]@{
    operatorToken = New-LatchToken -Prefix "op"
    agentToken = New-LatchToken -Prefix "agent"
    createdAt = $Now
    rotatedAt = $Now
    rotationReason = "emergency-lockdown"
    previousBackup = $BackupPath
}

$NewAuth | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $AuthPath -Encoding UTF8

$StopScript = Join-Path $Root "Stop-Latch.ps1"
$StartScript = Join-Path $Root "Start-Latch-Tailscale.ps1"
$StatusScript = Join-Path $Root "Status-Latch.ps1"

if ($StopServing) {
    & powershell -ExecutionPolicy Bypass -File $StopScript
} elseif (-not $NoRestart) {
    & powershell -ExecutionPolicy Bypass -File $StopScript | Out-Null
    & powershell -ExecutionPolicy Bypass -File $StartScript -WaitSeconds 20 | Out-Null
}

$Status = if (-not $StopServing -and (Test-Path -LiteralPath $StatusScript)) {
    try {
        & powershell -ExecutionPolicy Bypass -File $StatusScript
    } catch {
        $_.Exception.Message
    }
} else {
    "Serving stopped or status skipped."
}

[PSCustomObject]@{
    Rotated = $true
    Backup = $BackupPath
    ServingStopped = [bool]$StopServing
    Restarted = -not $StopServing -and -not $NoRestart
    NewOperatorKeyLocation = $AuthPath
    OpenClawAgentNeedsUpdate = $true
    Status = $Status
}

param(
    [string]$Provider = "ntfy",

    [string]$Url = "",

    [string]$Token = "",

    [switch]$PromptForToken,

    [switch]$Enable,

    [switch]$Disable,

    [int]$TimeoutMs = 5000
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataDir = Join-Path $Root "data"
$ConfigPath = Join-Path $DataDir "notifications.json"

if (-not (Test-Path -LiteralPath $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir | Out-Null
}

$Existing = $null
if (Test-Path -LiteralPath $ConfigPath) {
    $Existing = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
}

if ($PromptForToken) {
    $SecureToken = Read-Host "Notification token" -AsSecureString
    $Token = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureToken)
    )
}

if (-not $Url -and $Existing -and $Existing.url) {
    $Url = $Existing.url
}

if (-not $Provider -and $Existing -and $Existing.provider) {
    $Provider = $Existing.provider
}

$Enabled = $false
if ($Disable) {
    $Enabled = $false
} elseif ($Enable) {
    $Enabled = $true
} elseif ($Existing) {
    $Enabled = [bool]$Existing.enabled
}

$FinalToken = if ($Token) {
    $Token
} elseif ($Existing -and $Existing.token) {
    $Existing.token
} else {
    ""
}

$Config = [ordered]@{
    provider = $Provider
    url = $Url
    token = $FinalToken
    enabled = $Enabled
    timeoutMs = $TimeoutMs
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
}

$Config | ConvertTo-Json | Set-Content -LiteralPath $ConfigPath -Encoding UTF8

[PSCustomObject]@{
    ConfigPath = $ConfigPath
    Provider = $Config.provider
    UrlConfigured = [bool]$Config.url
    HasToken = [bool]$Config.token
    Enabled = $Config.enabled
    Ready = [bool]($Config.enabled -and $Config.url)
}

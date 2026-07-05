<#
    Configure-Operator-Email.ps1

    Sets up YOUR personal SEND connector (data/operator-email.json). The trusted host sends drafted
    replies from YOUR address after you approve them (external_contact / approved_connector). The
    worker never receives these credentials. This is send-only: no inbox is ever read, so no IMAP.

    The app password is read with a secure prompt and written only to data/operator-email.json
    (gitignored). It is never echoed to the console.

    Gmail example:
        1. Enable 2-Step Verification on your Google account.
        2. Create an app password: https://myaccount.google.com/apppasswords
        3. Run:
           .\Configure-Operator-Email.ps1 -FromAddress you@gmail.com -FromName "Your Name" -PromptForPassword -Enable
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$FromAddress,

    [string]$FromName = "",

    [string]$SmtpHost = "smtp.gmail.com",

    [int]$SmtpPort = 465,

    [string]$SmtpUser = "",

    [switch]$PromptForPassword,

    [switch]$Enable,

    [switch]$Disable,

    [int]$MaxSendsPerHour = 30,

    [int]$MaxSendsPerDay = 200,

    [int]$TimeoutMs = 30000
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataDir = Join-Path $Root "data"
$ConfigPath = Join-Path $DataDir "operator-email.json"

if (-not (Test-Path -LiteralPath $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir | Out-Null
}

$Existing = $null
if (Test-Path -LiteralPath $ConfigPath) {
    $Existing = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
}

if (-not $SmtpUser) { $SmtpUser = $FromAddress }

# Password: secure prompt, or reuse the existing one if not re-prompting.
$Password = ""
if ($PromptForPassword) {
    $Secure = Read-Host "SMTP app password (send-only)" -AsSecureString
    $Password = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    )
    # Gmail shows app passwords as 4 groups of 4 with spaces; SMTP wants them with no spaces.
    $Password = ($Password -replace '\s', '')
} elseif ($Existing -and $Existing.smtp -and $Existing.smtp.pass) {
    $Password = $Existing.smtp.pass
}

if (-not $Password) {
    throw "No app password provided. Re-run with -PromptForPassword."
}

$Enabled = $true
if ($Disable) {
    $Enabled = $false
} elseif ($Enable) {
    $Enabled = $true
} elseif ($Existing -and ($null -ne $Existing.enabled)) {
    $Enabled = [bool]$Existing.enabled
}

$Config = [ordered]@{
    enabled     = $Enabled
    transport   = "smtp"
    fromAddress = $FromAddress
    fromName    = $FromName
    smtp        = [ordered]@{
        host = $SmtpHost
        port = $SmtpPort
        user = $SmtpUser
        pass = $Password
    }
    limits      = [ordered]@{
        maxSendsPerHour = $MaxSendsPerHour
        maxSendsPerDay  = $MaxSendsPerDay
    }
    timeoutMs   = $TimeoutMs
    updatedAt   = (Get-Date).ToUniversalTime().ToString("o")
}

# Write UTF-8 WITHOUT a BOM. PowerShell 5.1's `Set-Content -Encoding UTF8` adds a BOM that Node's
# JSON.parse rejects, so write the bytes directly with a BOM-less encoder.
$Json = $Config | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($ConfigPath, $Json, (New-Object System.Text.UTF8Encoding($false)))

[PSCustomObject]@{
    ConfigPath      = $ConfigPath
    FromAddress     = $Config.fromAddress
    SmtpHost        = $Config.smtp.host
    SmtpPort        = $Config.smtp.port
    HasPassword     = [bool]$Config.smtp.pass
    Enabled         = $Config.enabled
    Transport       = $Config.transport
    Note            = "Send-only. No IMAP. The host reads this file fresh at send time (no restart needed)."
}

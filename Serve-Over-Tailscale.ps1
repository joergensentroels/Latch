param(
    [string]$Port = "",

    [switch]$StatusOnly
)

$ErrorActionPreference = "Stop"

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "Latch-Config.ps1")

$Port = Resolve-LatchPort -Port $Port
$Tailscale = Resolve-TailscaleCli
$Target = "127.0.0.1:$Port"
$DetectedHttpsUrl = $null
$ServeStatusText = ""

function Read-TailscaleServeStatus {
    try {
        $Text = (& $Tailscale serve status 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            return ""
        }
        return $Text
    } catch {
        Write-Warning "Could not read Tailscale Serve status: $($_.Exception.Message)"
        return ""
    }
}

function Find-ServeHttpsUrl {
    param([string]$StatusText)

    if (-not $StatusText -or $StatusText -match "No serve config") {
        return $null
    }

    $Match = [regex]::Match($StatusText, "https://[a-zA-Z0-9.-]+\.ts\.net")
    if ($Match.Success) {
        return $Match.Value
    }

    return $null
}

function Save-ServeUrl {
    param([string]$Url)

    if (-not $Url) {
        return
    }

    $Config = Get-LatchLocalConfig
    $Config | Add-Member -NotePropertyName privateHttpsUrl -NotePropertyValue $Url -Force
    $Config | Add-Member -NotePropertyName tailscaleServeTarget -NotePropertyValue $Target -Force
    $Config | Add-Member -NotePropertyName tailscaleServeUpdatedAt -NotePropertyValue (Get-Date).ToUniversalTime().ToString("o") -Force
    Save-LatchLocalConfig -Config $Config
    Write-Host "Latch private HTTPS URL: $Url"
}

function Invoke-TailscaleCommand {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [int]$TimeoutSeconds = 25,
        [switch]$AllowFailure
    )

    $Job = Start-Job -ScriptBlock {
        param([string]$Exe, [string[]]$ArgList)
        $Output = (& $Exe @ArgList 2>&1 | Out-String).Trim()
        [PSCustomObject]@{
            ExitCode = $LASTEXITCODE
            Output = $Output
        }
    } -ArgumentList $Tailscale, $Arguments

    if (-not (Wait-Job -Job $Job -Timeout $TimeoutSeconds)) {
        Stop-Job -Job $Job | Out-Null
        Remove-Job -Job $Job | Out-Null
        throw "Tailscale command timed out. Open an Administrator PowerShell or the Tailscale app and approve any Serve/HTTPS prompt, then rerun this script."
    }

    $Result = Receive-Job -Job $Job
    Remove-Job -Job $Job | Out-Null

    if ($Result.ExitCode -ne 0 -and -not $AllowFailure) {
        if (-not $Result.Output) {
            $Result.Output = "No output from tailscale.exe. This often means Tailscale Serve needs the HTTPS consent step in an interactive/admin session."
        }
        throw "tailscale $($Arguments -join ' ') failed with exit code $($Result.ExitCode). $($Result.Output)"
    }
    if ($Result.ExitCode -ne 0 -and $AllowFailure) {
        return ""
    }

    return $Result.Output
}

$ServeStatusText = Read-TailscaleServeStatus
if ($ServeStatusText) {
    Write-Host $ServeStatusText
}

$ExistingHttpsUrl = Find-ServeHttpsUrl -StatusText $ServeStatusText
if ($ExistingHttpsUrl) {
    Save-ServeUrl -Url $ExistingHttpsUrl
    exit 0
}

$StatusJson = $null
try {
    $StatusText = (& $Tailscale status --json 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw $StatusText
    }
    $StatusJson = $StatusText | ConvertFrom-Json
} catch {
    Write-Warning "Could not read Tailscale status: $($_.Exception.Message)"
}

if ($StatusJson.Self.DNSName) {
    $DetectedHttpsUrl = "https://$($StatusJson.Self.DNSName.TrimEnd('.'))"
}

if ($StatusOnly) {
    Write-Warning "Private HTTPS URL was not detected. Run this script without -StatusOnly to configure Tailscale Serve."
    exit 1
}

if (-not $StatusJson -or -not $StatusJson.Self.CertDomains) {
    Write-Warning @"
Tailscale HTTPS certificates are not enabled for this tailnet yet, so private HTTPS Serve cannot be started in background mode.

Enable it once, then rerun this script:
  1. Open https://login.tailscale.com/admin/dns
  2. Enable HTTPS certificates for the tailnet.
  3. Run: powershell -ExecutionPolicy Bypass -File .\Serve-Over-Tailscale.ps1

Alternative: run this in an interactive Administrator PowerShell and follow any browser consent prompt:
  & "$Tailscale" serve $Port

Do not run tailscale funnel for Latch.
"@
    exit 1
}

Write-Host "Starting private Tailscale Serve for Latch -> local port $Port"
Write-Host "This uses tailscale serve, not tailscale funnel, so it stays private to your tailnet."
Invoke-TailscaleCommand -Arguments @("serve", "--yes", "--bg", $Port) -TimeoutSeconds 25 | Out-Null

$ServeStatusText = Read-TailscaleServeStatus
if ($ServeStatusText) {
    Write-Host $ServeStatusText
}

$PrivateHttpsUrl = Find-ServeHttpsUrl -StatusText $ServeStatusText
if (-not $PrivateHttpsUrl -and $DetectedHttpsUrl) {
    $PrivateHttpsUrl = $DetectedHttpsUrl
}

if ($PrivateHttpsUrl) {
    Save-ServeUrl -Url $PrivateHttpsUrl
} else {
    Write-Warning "Private HTTPS URL was not detected. Run 'tailscale serve status' or check the Tailscale app if setup prompts for HTTPS consent."
}

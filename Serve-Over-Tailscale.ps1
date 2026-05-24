param(
    [string]$Port = "",

    [switch]$StatusOnly
)

$ErrorActionPreference = "Stop"

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "Latch-Config.ps1")

$Port = Resolve-LatchPort -Port $Port
$Tailscale = Resolve-TailscaleCli
$Target = "127.0.0.1:$Port"

function Invoke-TailscaleCommand {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [int]$TimeoutSeconds = 25,
        [switch]$AllowFailure
    )

    $Job = Start-Job -ScriptBlock {
        param([string]$Exe, [string[]]$ArgList)
        $ErrorActionPreference = "SilentlyContinue"
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
        throw "tailscale $($Arguments -join ' ') failed: $($Result.Output)"
    }
    if ($Result.ExitCode -ne 0 -and $AllowFailure) {
        return ""
    }

    return $Result.Output
}

if (-not $StatusOnly) {
    Write-Host "Starting private Tailscale Serve for Latch -> $Target"
    Write-Host "This uses tailscale serve, not tailscale funnel, so it stays private to your tailnet."
    Invoke-TailscaleCommand -Arguments @("serve", "--yes", "--bg", $Target) -TimeoutSeconds 25 | Out-Null
}

$ServeStatusText = ""
try {
    $ServeStatusText = Invoke-TailscaleCommand -Arguments @("serve", "status") -TimeoutSeconds 15 -AllowFailure
    if ($ServeStatusText) {
        Write-Host $ServeStatusText
    }
} catch {
    Write-Warning "Could not read Tailscale Serve status: $($_.Exception.Message)"
}

$PrivateHttpsUrl = $null
try {
    $StatusText = Invoke-TailscaleCommand -Arguments @("status", "--json") -TimeoutSeconds 15 -AllowFailure
    $StatusJson = $StatusText | ConvertFrom-Json
    if ($StatusJson.Self.DNSName) {
        $PrivateHttpsUrl = "https://$($StatusJson.Self.DNSName.TrimEnd('.'))"
    }
} catch {
    Write-Warning "Could not read Tailscale DNS name: $($_.Exception.Message)"
}

if (-not $PrivateHttpsUrl -and $ServeStatusText) {
    $Match = [regex]::Match($ServeStatusText, "https://[a-zA-Z0-9.-]+\.ts\.net")
    if ($Match.Success) {
        $PrivateHttpsUrl = $Match.Value
    }
}

if ($PrivateHttpsUrl) {
    $Config = Get-LatchLocalConfig
    $Config | Add-Member -NotePropertyName privateHttpsUrl -NotePropertyValue $PrivateHttpsUrl -Force
    $Config | Add-Member -NotePropertyName tailscaleServeTarget -NotePropertyValue $Target -Force
    $Config | Add-Member -NotePropertyName tailscaleServeUpdatedAt -NotePropertyValue (Get-Date).ToUniversalTime().ToString("o") -Force
    Save-LatchLocalConfig -Config $Config
    Write-Host "Latch private HTTPS URL: $PrivateHttpsUrl"
} else {
    Write-Warning "Private HTTPS URL was not detected. Run 'tailscale serve status' or check the Tailscale app if setup prompts for HTTPS consent."
}

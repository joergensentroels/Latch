param(
    [string]$HostAddress = "",

    [string]$Port = "",

    [int]$WaitSeconds = 120,

    [switch]$NoRestartExisting
)

$ErrorActionPreference = "Stop"

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "Latch-Config.ps1")

$HostAddress = Resolve-LatchHostAddress -HostAddress $HostAddress
$Port = Resolve-LatchPort -Port $Port

function Wait-ForHostAddress {
    param(
        [string]$HostAddress,
        [int]$TimeoutSeconds
    )

    $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $Deadline) {
        $Address = Get-NetIPAddress -IPAddress $HostAddress -ErrorAction SilentlyContinue
        if ($Address) {
            Write-Output "Found host address $HostAddress on interface $($Address.InterfaceAlias)."
            return
        }
        Write-Output "Waiting for host address $HostAddress..."
        Start-Sleep -Seconds 3
    }

    throw "Timed out waiting for host address $HostAddress. Is Tailscale running?"
}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:HOSTS = "127.0.0.1,$HostAddress"
$env:HOST = $HostAddress
$env:PORT = $Port
$ProfileRoot = $env:USERPROFILE
if ($Root -match "^(.*?\\Users\\[^\\]+)\\") {
    $ProfileRoot = $Matches[1]
}
$BundledNode = Join-Path $ProfileRoot ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$NodeExe = if (Test-Path -LiteralPath $BundledNode) { $BundledNode } else { "node" }

Wait-ForHostAddress -HostAddress $HostAddress -TimeoutSeconds $WaitSeconds

$Existing = Get-NetTCPConnection -LocalPort ([int]$Port) -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq "Listen" }

if ($Existing) {
    if ($NoRestartExisting) {
        try {
            $Health = Invoke-RestMethod -Uri "http://$HostAddress`:$Port/api/health" -Method Get -TimeoutSec 3
            Write-Output "Latch is already running on http://$HostAddress`:$Port ($($Health.app))."
            exit 0
        } catch {
            Write-Output "Port $Port is already listening on $HostAddress, but health check failed."
            exit 1
        }
    }

    foreach ($ProcessId in ($Existing | Select-Object -ExpandProperty OwningProcess -Unique)) {
        $Process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
        if ($Process -and $Process.ProcessName -eq "node") {
            Stop-Process -Id $Process.Id -Force
            Write-Output "Stopped existing Latch Node process $($Process.Id) on port $Port."
        } else {
            throw "Port $Port is already used by non-Node process PID $ProcessId."
        }
    }

    Start-Sleep -Seconds 1
}

Set-Location $Root

# Ensure the phone's HTTPS Tailscale Serve URL (https://<node>.<tailnet>.ts.net) proxies to this
# server. Serve config can be cleared by a reboot or a Tailscale restart, which leaves the phone
# unable to reach Latch even though the server is fine; re-establishing it here (idempotent, --bg
# so it persists) keeps the phone route working across restarts. Best-effort.
try {
    & tailscale serve --bg $Port 2>$null | Out-Null
    Write-Output "Tailscale Serve: HTTPS proxy -> http://127.0.0.1:$Port ensured (phone URL)."
} catch {
    Write-Output "Tailscale Serve not set (tailscale CLI unavailable); the phone's HTTPS URL may not resolve."
}

& $NodeExe .\server.js

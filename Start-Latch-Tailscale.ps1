param(
    [string]$HostAddress = "",

    [string]$Port = "",

    [int]$WaitSeconds = 120
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

$Existing = Get-NetTCPConnection -LocalAddress $HostAddress -LocalPort ([int]$Port) -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq "Listen" } |
    Select-Object -First 1

if ($Existing) {
    try {
        $Health = Invoke-RestMethod -Uri "http://$HostAddress`:$Port/api/health" -Method Get -TimeoutSec 3
        Write-Output "Latch is already running on http://$HostAddress`:$Port ($($Health.app))."
        exit 0
    } catch {
        Write-Output "Port $Port is already listening on $HostAddress, but health check failed."
        exit 1
    }
}

Set-Location $Root
& $NodeExe .\server.js

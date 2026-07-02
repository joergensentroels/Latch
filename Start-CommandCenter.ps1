param(
    # Start anyway even if the port already looks busy (skips the running-instance check).
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:HOST = if ($env:HOST) { $env:HOST } else { "127.0.0.1" }
$env:PORT = if ($env:PORT) { $env:PORT } else { "8787" }
$BundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$NodeExe = if (Test-Path -LiteralPath $BundledNode) { $BundledNode } else { "node" }

# Pre-flight: if Latch is already listening on this port, don't crash with a raw
# EADDRINUSE stack trace. Report the running instance and exit cleanly instead.
if (-not $Force) {
    $portInUse = $false
    try {
        $portInUse = [bool](Get-NetTCPConnection -LocalPort ([int]$env:PORT) -State Listen -ErrorAction Stop)
    } catch {
        # Get-NetTCPConnection unavailable (older/edge Windows): fall back to a TCP probe.
        try {
            $client = [System.Net.Sockets.TcpClient]::new()
            $client.Connect($env:HOST, [int]$env:PORT)
            $portInUse = $client.Connected
            $client.Close()
        } catch { $portInUse = $false }
    }

    if ($portInUse) {
        $url = "http://$($env:HOST):$($env:PORT)"
        Write-Host "Latch is already running at $url" -ForegroundColor Green
        Write-Host "Open that URL, or use Status-Latch.ps1 to inspect it and Stop-Latch.ps1 to stop it." -ForegroundColor Green
        Write-Host "Re-run with -Force to start anyway (this will fail if the port is genuinely taken)." -ForegroundColor DarkGray
        return
    }
}

Set-Location $Root
& $NodeExe .\server.js

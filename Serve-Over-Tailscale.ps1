$ErrorActionPreference = "Stop"

$Port = if ($env:PORT) { $env:PORT } else { "8787" }
$Tailscale = Get-Command tailscale -ErrorAction SilentlyContinue
if (-not $Tailscale -and (Test-Path -LiteralPath "C:\Program Files\Tailscale\tailscale.exe")) {
    $Tailscale = Get-Item -LiteralPath "C:\Program Files\Tailscale\tailscale.exe"
}

if (-not $Tailscale) {
    throw "Tailscale CLI was not found. Install and sign in to Tailscale first."
}

& $Tailscale.FullName serve --yes --bg "127.0.0.1:$Port"
& $Tailscale.FullName serve status

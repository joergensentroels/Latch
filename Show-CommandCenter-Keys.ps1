$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$AuthPath = Join-Path $Root "data\auth.json"

if (-not (Test-Path -LiteralPath $AuthPath)) {
    "Keys have not been generated yet. Start the app once first."
    exit 1
}

Get-Content -LiteralPath $AuthPath

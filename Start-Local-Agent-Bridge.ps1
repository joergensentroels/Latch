param(
    [string]$BaseUrl = "http://127.0.0.1:8787",

    [string]$AgentKey = "",

    [string]$WorkerName = "local-compass-bridge",

    [switch]$ProcessExistingMessages,

    [switch]$Once
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$AuthPath = Join-Path $Root "data\auth.json"

if (-not $AgentKey -and (Test-Path -LiteralPath $AuthPath)) {
    $Auth = Get-Content -LiteralPath $AuthPath -Raw | ConvertFrom-Json
    $AgentKey = $Auth.agentToken
}

if (-not $AgentKey) {
    throw "Missing AgentKey."
}

$PythonExe = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if (-not (Test-Path -LiteralPath $PythonExe)) {
    $PythonExe = "python"
}

$StateDir = Join-Path $Root "data\local-agent-bridge"
New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
$StatePath = Join-Path $StateDir "state.json"

$Args = @(
    (Join-Path $Root "worker\latch-agent-bridge.py"),
    "--base-url", $BaseUrl,
    "--agent-key", $AgentKey,
    "--worker-name", $WorkerName,
    "--state-path", $StatePath,
    "--interval", "5"
)

if ($ProcessExistingMessages) {
    $Args += "--process-existing-messages"
}

if ($Once) {
    $Args += "--once"
}

Set-Location $Root
& $PythonExe @Args

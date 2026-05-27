param(
    [string]$BaseUrl = "http://127.0.0.1:8787",

    [string]$Name = "Loopback Mistral",

    [ValidateSet("ollama", "openai-compatible")]
    [string]$Backend = "ollama",

    [string]$Models = "mistral",

    [string]$DefaultModel = "mistral",

    [string]$BackendUrl = "http://127.0.0.1:11434",

    [switch]$UseLlmProviderConfig,

    [switch]$NoRestartLatch
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$AuthPath = Join-Path $Root "data\auth.json"

function Wait-ForLatch {
    param(
        [string]$Url,
        [int]$TimeoutSeconds = 20
    )

    $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $Deadline) {
        try {
            $Health = Invoke-RestMethod -Uri "$Url/api/health" -Method Get -TimeoutSec 2
            if ($Health.ok) {
                return
            }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }

    throw "Latch did not become healthy at $Url within $TimeoutSeconds seconds."
}

if (-not $NoRestartLatch) {
    Write-Output "Restarting local Latch server so the latest network code is active..."
    $BaseUri = [Uri]$BaseUrl
    $Port = if ($BaseUri.Port -gt 0) { $BaseUri.Port } else { 8787 }
    & (Join-Path $Root "Stop-Latch.ps1") -Port ([int]$Port)

    $DataDir = Join-Path $Root "data"
    if (-not (Test-Path -LiteralPath $DataDir)) {
        New-Item -ItemType Directory -Path $DataDir | Out-Null
    }
    $LogStamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $StdoutPath = Join-Path $DataDir "network-invite-latch-$LogStamp.out.log"
    $StderrPath = Join-Path $DataDir "network-invite-latch-$LogStamp.err.log"

    $ProfileRoot = $env:USERPROFILE
    $BundledNode = Join-Path $ProfileRoot ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
    $NodeExe = if (Test-Path -LiteralPath $BundledNode) { $BundledNode } else { "node" }
    $ServerPath = Join-Path $Root "server.js"
    $LaunchScript = Join-Path $DataDir "network-invite-start-latch-$LogStamp.ps1"
    $LaunchContent = @'
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath '__ROOT__'
$env:HOST = "127.0.0.1"
$env:HOSTS = "127.0.0.1"
$env:PORT = "__PORT__"
& '__NODE__' '__SERVER__'
'@
    $LaunchContent = $LaunchContent.
        Replace("__ROOT__", $Root).
        Replace("__PORT__", [string]$Port).
        Replace("__NODE__", $NodeExe).
        Replace("__SERVER__", $ServerPath)
    Set-Content -LiteralPath $LaunchScript -Value $LaunchContent -Encoding UTF8
    $Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$LaunchScript`""
    $PowerShellExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $PowerShellExe
    $psi.Arguments = $Arguments
    $psi.WorkingDirectory = $Root
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $Process = [System.Diagnostics.Process]::Start($psi)
    try {
        Wait-ForLatch -Url $BaseUrl -TimeoutSeconds 45
    } catch {
        $Out = Get-Content -LiteralPath $StdoutPath -Raw -ErrorAction SilentlyContinue
        $Err = Get-Content -LiteralPath $StderrPath -Raw -ErrorAction SilentlyContinue
        throw "$($_.Exception.Message)`nStarted process: $($Process.Id)`nStdout: $Out`nStderr: $Err"
    }
}

if (-not (Test-Path -LiteralPath $AuthPath)) {
    throw "Missing data\auth.json. Start Latch once, then rerun this script."
}

if ($UseLlmProviderConfig) {
    $ProviderPath = Join-Path $Root "data\llm-provider.json"
    if (-not (Test-Path -LiteralPath $ProviderPath)) {
        throw "Missing data\llm-provider.json. Configure the external LLM provider first."
    }
    $Provider = Get-Content -LiteralPath $ProviderPath -Raw | ConvertFrom-Json
    if (-not $Provider.baseUrl -or -not $Provider.model -or -not $Provider.apiKey) {
        throw "data\llm-provider.json must contain baseUrl, model, and apiKey for external worker mode."
    }
    $Backend = "openai-compatible"
    $BackendUrl = $Provider.baseUrl
    $DefaultModel = $Provider.model
    $Models = $Provider.model
}

$Auth = Get-Content -LiteralPath $AuthPath -Raw | ConvertFrom-Json
$OperatorKey = $Auth.operatorToken
if (-not $OperatorKey) {
    throw "Missing operator token in data\auth.json."
}

$Headers = @{ Authorization = "Bearer $OperatorKey" }
$Body = @{
    name = $Name
    backendType = $Backend
    models = @($Models -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    defaultModel = $DefaultModel
} | ConvertTo-Json

$Invite = Invoke-RestMethod -Uri "$BaseUrl/api/network/workers" -Method Post -Headers $Headers -ContentType "application/json" -Body $Body
$PythonExe = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if (-not (Test-Path -LiteralPath $PythonExe)) {
    $PythonExe = "python"
}

$BackendConfigLine = if ($UseLlmProviderConfig) { "  --backend-config `".\data\llm-provider.json`" ``" } else { "" }
$Command = @"
& "$PythonExe" ``
  .\worker\latch-network-worker.py ``
  --base-url "$BaseUrl" ``
  --worker-token "$($Invite.token)" ``
  --backend "$Backend" ``
  --backend-url "$BackendUrl" ``
$BackendConfigLine
  --models "$Models" ``
  --default-model "$DefaultModel"
"@

[PSCustomObject]@{
    WorkerId = $Invite.worker.id
    WorkerName = $Invite.worker.name
    Backend = $Invite.worker.backendType
    Models = ($Invite.worker.models -join ", ")
    Token = $Invite.token
    RunCommand = $Command.Trim()
}

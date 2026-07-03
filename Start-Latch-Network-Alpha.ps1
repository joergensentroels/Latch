param(
    [string]$BaseUrl = "http://127.0.0.1:8787",

    [string]$WorkerName = "operator",

    [switch]$NoRestartLatch,

    [switch]$ProcessExistingMessages
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataDir = Join-Path $Root "data"
$AuthPath = Join-Path $DataDir "auth.json"
$ProviderPath = Join-Path $DataDir "llm-provider.json"

function Get-BundledNode {
    $Candidate = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
    if (Test-Path -LiteralPath $Candidate) { return $Candidate }
    return "node"
}

function Get-BundledPython {
    $Candidate = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
    if (Test-Path -LiteralPath $Candidate) { return $Candidate }
    return "python"
}

function Wait-ForLatch {
    param([string]$Url, [int]$TimeoutSeconds = 45)
    $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $Deadline) {
        try {
            $Health = Invoke-RestMethod -Uri "$Url/api/health" -Method Get -TimeoutSec 2
            if ($Health.ok) { return }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    throw "Latch did not become healthy at $Url within $TimeoutSeconds seconds."
}

function Start-HiddenPowerShell {
    param(
        [string]$ScriptPath,
        [string]$WorkingDirectory
    )
    $PowerShellExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $PowerShellExe
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""
    $psi.WorkingDirectory = $WorkingDirectory
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    return [System.Diagnostics.Process]::Start($psi)
}

function Start-LatchLocal {
    param([string]$Url)
    $BaseUri = [Uri]$Url
    $Port = if ($BaseUri.Port -gt 0) { $BaseUri.Port } else { 8787 }
    & (Join-Path $Root "Stop-Latch.ps1") -Port ([int]$Port) | Out-Host

    $Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $ScriptPath = Join-Path $DataDir "alpha-start-latch-$Stamp.ps1"
    $NodeExe = Get-BundledNode
    $ServerPath = Join-Path $Root "server.js"
    @"
`$ErrorActionPreference = "Stop"
Set-Location -LiteralPath '$Root'
`$env:HOST = "127.0.0.1"
`$env:HOSTS = "127.0.0.1"
`$env:PORT = "$Port"
& '$NodeExe' '$ServerPath'
"@ | Set-Content -LiteralPath $ScriptPath -Encoding UTF8
    $Process = Start-HiddenPowerShell -ScriptPath $ScriptPath -WorkingDirectory $Root
    Wait-ForLatch -Url $Url
    return $Process
}

function New-NetworkInvite {
    param(
        [string]$Url,
        [string]$Name,
        [object]$Provider,
        [string]$OperatorKey
    )
    $Headers = @{ Authorization = "Bearer $OperatorKey" }
    $Body = @{
        name = $Name
        backendType = "openai-compatible"
        models = @($Provider.model)
        defaultModel = $Provider.model
    } | ConvertTo-Json
    return Invoke-RestMethod -Uri "$Url/api/network/workers" -Method Post -Headers $Headers -ContentType "application/json" -Body $Body
}

function Start-NetworkWorker {
    param(
        [string]$Url,
        [string]$Token,
        [string]$Name
    )
    $Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $ScriptPath = Join-Path $DataDir "alpha-start-network-worker-$Stamp.ps1"
    $PythonExe = Get-BundledPython
    $WorkerScript = Join-Path $Root "worker\latch-network-worker.py"
    $StateLog = Join-Path $DataDir "alpha-network-worker-$Stamp.log"
    @"
`$ErrorActionPreference = "Stop"
Set-Location -LiteralPath '$Root'
& '$PythonExe' '$WorkerScript' --base-url '$Url' --worker-token '$Token' --worker-name '$Name' --backend 'openai-compatible' --backend-config '.\data\llm-provider.json' *>&1 | Tee-Object -FilePath '$StateLog'
"@ | Set-Content -LiteralPath $ScriptPath -Encoding UTF8
    return Start-HiddenPowerShell -ScriptPath $ScriptPath -WorkingDirectory $Root
}

function Start-LocalBridge {
    param(
        [string]$Url,
        [string]$AgentKey
    )
    $Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $ScriptPath = Join-Path $DataDir "alpha-start-local-bridge-$Stamp.ps1"
    $PythonExe = Get-BundledPython
    $BridgeScript = Join-Path $Root "worker\latch-agent-bridge.py"
    $StateDir = Join-Path $DataDir "local-agent-bridge"
    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
    $StatePath = Join-Path $StateDir "state.json"
    $BridgeLog = Join-Path $DataDir "alpha-local-bridge-$Stamp.log"
    $ExistingFlag = if ($ProcessExistingMessages) { "--process-existing-messages" } else { "" }
    @"
`$ErrorActionPreference = "Stop"
Set-Location -LiteralPath '$Root'
& '$PythonExe' '$BridgeScript' --base-url '$Url' --agent-key '$AgentKey' --worker-name 'local-compass-bridge' --state-path '$StatePath' --interval 5 $ExistingFlag *>&1 | Tee-Object -FilePath '$BridgeLog'
"@ | Set-Content -LiteralPath $ScriptPath -Encoding UTF8
    return Start-HiddenPowerShell -ScriptPath $ScriptPath -WorkingDirectory $Root
}

if (-not (Test-Path -LiteralPath $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir | Out-Null
}

if (-not $NoRestartLatch) {
    Write-Output "Starting local Latch..."
    $LatchProcess = Start-LatchLocal -Url $BaseUrl
} else {
    Wait-ForLatch -Url $BaseUrl
    $LatchProcess = $null
}

if (-not (Test-Path -LiteralPath $AuthPath)) {
    throw "Missing data\auth.json. Start Latch once first."
}
if (-not (Test-Path -LiteralPath $ProviderPath)) {
    throw "Missing data\llm-provider.json. Configure the external LLM provider first."
}

$Auth = Get-Content -LiteralPath $AuthPath -Raw | ConvertFrom-Json
$Provider = Get-Content -LiteralPath $ProviderPath -Raw | ConvertFrom-Json
if (-not $Provider.baseUrl -or -not $Provider.model -or -not $Provider.apiKey) {
    throw "data\llm-provider.json must contain baseUrl, model, and apiKey."
}

$Invite = New-NetworkInvite -Url $BaseUrl -Name $WorkerName -Provider $Provider -OperatorKey $Auth.operatorToken
$NetworkWorkerProcess = Start-NetworkWorker -Url $BaseUrl -Token $Invite.token -Name $WorkerName
$BridgeProcess = Start-LocalBridge -Url $BaseUrl -AgentKey $Auth.agentToken

Start-Sleep -Seconds 3

$Headers = @{ Authorization = "Bearer $($Auth.operatorToken)" }
$State = Invoke-RestMethod -Uri "$BaseUrl/api/state" -Method Get -Headers $Headers
$Worker = @($State.network.workers | Where-Object { $_.id -eq $Invite.worker.id } | Select-Object -First 1)
$LatestJob = @($State.network.jobs | Select-Object -First 1)

[PSCustomObject]@{
    LatchUrl = $BaseUrl
    LatchPid = if ($LatchProcess) { $LatchProcess.Id } else { "" }
    NetworkWorkerPid = $NetworkWorkerProcess.Id
    BridgePid = $BridgeProcess.Id
    WorkerName = $Worker.name
    WorkerStatus = $Worker.status
    WorkerHealth = $Worker.health
    WorkerModel = $Worker.defaultModel
    LatestJob = if ($LatestJob) { "$($LatestJob.status) $($LatestJob.model) $($LatestJob.workerName)" } else { "none" }
    NextStep = "Open $BaseUrl, keep this shell free, and send Compass an Allow network message."
}

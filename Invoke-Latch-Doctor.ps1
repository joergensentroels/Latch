param(
    [string]$BaseUrl = "",

    [string]$HostAddress = "",

    [string]$Port = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $Root "Latch-Config.ps1")

$MachinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
$UserPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
$env:Path = "$MachinePath;$UserPath"

$HostAddress = Resolve-LatchHostAddress -HostAddress $HostAddress
$Port = Resolve-LatchPort -Port $Port
if (-not $BaseUrl) {
    $BaseUrl = "http://$HostAddress`:$Port"
}

$AuthPath = Join-Path $Root "data\auth.json"
$OperatorKey = ""
if (Test-Path -LiteralPath $AuthPath) {
    $Auth = Get-Content -LiteralPath $AuthPath -Raw | ConvertFrom-Json
    $OperatorKey = $Auth.operatorToken
}

$Headers = if ($OperatorKey) { @{ Authorization = "Bearer $OperatorKey" } } else { @{} }

function Test-Step {
    param(
        [string]$Name,
        [scriptblock]$Action
    )

    try {
        $Result = & $Action
        [PSCustomObject]@{
            Check = $Name
            Ok = $true
            Detail = $Result
        }
    } catch {
        [PSCustomObject]@{
            Check = $Name
            Ok = $false
            Detail = $_.Exception.Message
        }
    }
}

$Checks = @()

$Checks += Test-Step "Latch health" {
    $Health = Invoke-RestMethod -Uri "$BaseUrl/api/health" -Method Get -TimeoutSec 5
    "$($Health.app) ok at $BaseUrl"
}

$Checks += Test-Step "Operator auth" {
    if (-not $OperatorKey) { throw "Missing data\auth.json operator token." }
    $State = Invoke-RestMethod -Uri "$BaseUrl/api/state" -Headers $Headers -TimeoutSec 5
    "$(($State.messages | Measure-Object).Count) messages, $(($State.tasks | Measure-Object).Count) tasks, $(($State.approvals | Measure-Object).Count) approvals"
}

$Checks += Test-Step "LLM gateway" {
    if (-not $OperatorKey) { throw "Missing operator token." }
    $Config = Invoke-RestMethod -Uri "$BaseUrl/api/llm/config" -Headers $Headers -TimeoutSec 5
    if (-not $Config.enabled) { throw "LLM disabled or not configured." }
    "$($Config.provider) / $($Config.model)"
}

$Checks += Test-Step "Worker freshness" {
    if (-not $OperatorKey) { throw "Missing operator token." }
    $State = Invoke-RestMethod -Uri "$BaseUrl/api/state" -Headers $Headers -TimeoutSec 5
    $Latest = $State.messages | Where-Object { $_.direction -eq "agent_to_operator" } | Select-Object -First 1
    if (-not $Latest) { throw "No worker messages found." }
    $CreatedAt = [datetimeoffset]::Parse($Latest.createdAt).ToUniversalTime()
    $Age = [datetimeoffset]::UtcNow - $CreatedAt
    $Minutes = [Math]::Max(0, [int]$Age.TotalMinutes)
    "last worker message $($Minutes)m ago"
}

$Checks += Test-Step "Git status" {
    $Git = Get-Command git -ErrorAction Stop
    $Status = & $Git.Source -C $Root status --short --branch
    ($Status -join "; ")
}

$Checks | Format-Table -AutoSize

if ($Checks | Where-Object { -not $_.Ok }) {
    exit 1
}

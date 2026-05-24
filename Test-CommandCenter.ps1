param(
    [string]$BaseUrl = "http://127.0.0.1:8787",

    [string]$OperatorKey = "",

    [string]$AgentKey = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$AuthPath = Join-Path $Root "data\auth.json"

if ((-not $OperatorKey -or -not $AgentKey) -and (Test-Path -LiteralPath $AuthPath)) {
    $Auth = Get-Content -LiteralPath $AuthPath -Raw | ConvertFrom-Json
    if (-not $OperatorKey) { $OperatorKey = $Auth.operatorToken }
    if (-not $AgentKey) { $AgentKey = $Auth.agentToken }
}

if (-not $OperatorKey) {
    throw "Missing OperatorKey."
}

if (-not $AgentKey) {
    throw "Missing AgentKey."
}

$OperatorHeaders = @{ Authorization = "Bearer $OperatorKey" }
$AgentHeaders = @{ Authorization = "Bearer $AgentKey" }

$Health = Invoke-RestMethod -Uri "$BaseUrl/api/health" -Method Get
$State = Invoke-RestMethod -Uri "$BaseUrl/api/state" -Method Get -Headers $OperatorHeaders
$LlmConfig = Invoke-RestMethod -Uri "$BaseUrl/api/llm/config" -Method Get -Headers $OperatorHeaders
$NotifyConfig = Invoke-RestMethod -Uri "$BaseUrl/api/notifications/config" -Method Get -Headers $OperatorHeaders
$Poll = Invoke-RestMethod -Uri "$BaseUrl/api/agent/poll" -Method Get -Headers $AgentHeaders

[PSCustomObject]@{
    BaseUrl = $BaseUrl
    Health = $Health.ok
    App = $Health.app
    LlmProvider = $LlmConfig.provider
    LlmModel = $LlmConfig.model
    LlmEnabled = $LlmConfig.enabled
    NotificationsProvider = $NotifyConfig.provider
    NotificationsReady = $NotifyConfig.ready
    TasksVisible = $State.tasks.Count
    ApprovalsVisible = $State.approvals.Count
    AgentPollTasks = $Poll.tasks.Count
    AgentPollApprovals = $Poll.approvals.Count
}

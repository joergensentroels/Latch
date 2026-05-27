param(
    [string]$BaseUrl = "http://127.0.0.1:8787",

    [string]$OperatorKey = "",

    [string]$Model = "",

    [string]$Prompt = "Use the Latch Network worker for this test. Reply with one concise sentence confirming the routed job completed."
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$AuthPath = Join-Path $Root "data\auth.json"

if (-not $OperatorKey -and (Test-Path -LiteralPath $AuthPath)) {
    $Auth = Get-Content -LiteralPath $AuthPath -Raw | ConvertFrom-Json
    $OperatorKey = $Auth.operatorToken
}

if (-not $OperatorKey) {
    throw "Missing OperatorKey."
}

if (-not $Model) {
    $DbPath = Join-Path $Root "data\db.json"
    if (Test-Path -LiteralPath $DbPath) {
        $Db = Get-Content -LiteralPath $DbPath -Raw | ConvertFrom-Json
        $Worker = @($Db.network.workers | Where-Object { $_.status -eq "active" } | Select-Object -First 1)
        if ($Worker) {
            $Model = if ($Worker.defaultModel) { $Worker.defaultModel } else { @($Worker.models)[0] }
        }
    }
}

if (-not $Model) {
    throw "No active network worker model found. Start a worker first or pass -Model."
}

$Headers = @{ Authorization = "Bearer $OperatorKey" }
$Body = @{
    prompt = $Prompt
    routingPreference = "network"
    allowNetwork = $true
    model = $Model
    maxTokens = 160
    networkTimeoutMs = 60000
} | ConvertTo-Json

$Response = Invoke-RestMethod -Uri "$BaseUrl/api/llm/chat" -Method Post -Headers $Headers -ContentType "application/json" -Body $Body -TimeoutSec 75

[PSCustomObject]@{
    Ok = $Response.ok
    Provider = $Response.provider
    Model = $Response.model
    RoutingMode = $Response.routing.mode
    Worker = $Response.routing.workerName
    Credits = $Response.routing.credits
    Error = $Response.error
    Text = $Response.text
}

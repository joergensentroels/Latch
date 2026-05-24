param(
    [string]$BaseUrl = "http://127.0.0.1:8787",

    [string]$OperatorKey = "",

    [string]$Prompt = "Reply with one short sentence confirming the external LLM gateway works."
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

$Headers = @{ Authorization = "Bearer $OperatorKey" }
$Config = Invoke-RestMethod -Uri "$BaseUrl/api/llm/config" -Method Get -Headers $Headers

if (-not $Config.enabled) {
    [PSCustomObject]@{
        BaseUrl = $BaseUrl
        Provider = $Config.provider
        LlmBaseUrl = $Config.baseUrl
        Model = $Config.model
        Enabled = $Config.enabled
        HasApiKey = $Config.hasApiKey
        Result = "External LLM is not configured yet."
    }
    exit 0
}

$Body = @{
    prompt = $Prompt
    temperature = 0.2
    maxTokens = 120
} | ConvertTo-Json

$Response = Invoke-RestMethod -Uri "$BaseUrl/api/llm/chat" -Method Post -Headers $Headers -ContentType "application/json" -Body $Body

[PSCustomObject]@{
    BaseUrl = $BaseUrl
    Provider = $Response.provider
    Model = $Response.model
    Ok = $Response.ok
    Status = $Response.status
    Error = $Response.error
    Text = $Response.text
}

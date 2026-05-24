param(
    [string]$BaseUrl = "http://127.0.0.1:8787",

    [string]$OperatorKey = ""
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
$Config = Invoke-RestMethod -Uri "$BaseUrl/api/notifications/config" -Method Get -Headers $Headers

if (-not $Config.ready) {
    [PSCustomObject]@{
        BaseUrl = $BaseUrl
        Provider = $Config.provider
        Enabled = $Config.enabled
        UrlConfigured = $Config.urlConfigured
        HasToken = $Config.hasToken
        Result = "Server-side phone push is not configured yet."
    }
    exit 0
}

$Result = Invoke-RestMethod -Uri "$BaseUrl/api/notifications/test" -Method Post -Headers $Headers -ContentType "application/json" -Body "{}"

[PSCustomObject]@{
    BaseUrl = $BaseUrl
    Provider = $Result.provider
    Ok = $Result.ok
}

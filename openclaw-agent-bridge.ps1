param(
    [Parameter(Mandatory = $true)]
    [string]$BaseUrl,

    [Parameter(Mandatory = $true)]
    [string]$AgentKey,

    [int]$IntervalSeconds = 10,

    [switch]$Once
)

$ErrorActionPreference = "Stop"
$Headers = @{ Authorization = "Bearer $AgentKey" }
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateDir = Join-Path $Root "data\agent"
$SeenPath = Join-Path $StateDir "seen-tasks.json"

New-Item -ItemType Directory -Path $StateDir -Force | Out-Null

function Get-SeenTasks {
    if (-not (Test-Path -LiteralPath $SeenPath)) {
        return @{}
    }

    $Raw = Get-Content -LiteralPath $SeenPath -Raw
    if (-not $Raw.Trim()) {
        return @{}
    }

    $Object = $Raw | ConvertFrom-Json
    $Map = @{}
    foreach ($Property in $Object.PSObject.Properties) {
        $Map[$Property.Name] = [bool]$Property.Value
    }
    return $Map
}

function Save-SeenTasks {
    param([hashtable]$Seen)

    $Seen | ConvertTo-Json | Set-Content -LiteralPath $SeenPath -Encoding ASCII
}

function Send-AgentReport {
    param(
        [string]$Text,
        [string]$TaskId = ""
    )

    $Body = @{
        text = $Text
        taskId = $TaskId
    } | ConvertTo-Json

    Invoke-RestMethod `
        -Uri "$BaseUrl/api/agent/report" `
        -Method Post `
        -Headers $Headers `
        -ContentType "application/json" `
        -Body $Body | Out-Null
}

Send-AgentReport "OpenClaw bridge connected from $env:COMPUTERNAME."
$SeenTasks = Get-SeenTasks

while ($true) {
    try {
        $Work = Invoke-RestMethod `
            -Uri "$BaseUrl/api/agent/poll" `
            -Method Get `
            -Headers $Headers

        foreach ($Task in $Work.tasks) {
            if ($Task.status -eq "queued" -and -not $SeenTasks.ContainsKey($Task.id)) {
                Send-AgentReport "Observed queued task: $($Task.title)" $Task.id
                $SeenTasks[$Task.id] = $true
                Save-SeenTasks $SeenTasks
            }
        }
    } catch {
        Write-Warning $_.Exception.Message
    }

    if ($Once) {
        break
    }

    Start-Sleep -Seconds $IntervalSeconds
}

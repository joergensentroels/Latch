param(
    [string]$BaseUrl = "",

    [string]$HostAddress = "",

    [string]$Port = "",

    [string]$VmHost = "",

    [string]$VmUser = "latchsetup",

    [string]$KeyPath = "$env:USERPROFILE\.ssh\latchsetup_openclaw_vm_codex"
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

function Invoke-OpenClawSsh {
    param([string]$Command)

    if (-not $VmHost) {
        throw "Missing -VmHost for VM checks."
    }
    if (!(Test-Path -LiteralPath $KeyPath)) {
        throw "SSH key not found: $KeyPath"
    }

    $SshTarget = "$VmUser@$VmHost"
    & ssh -i $KeyPath -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 $SshTarget $Command
}

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

$Checks += Test-Step "Latch listener" {
    try {
        $Listeners = Get-NetTCPConnection -LocalPort ([int]$Port) -State Listen -ErrorAction Stop |
            Select-Object -ExpandProperty LocalAddress
    } catch {
        return "listener check skipped: $($_.Exception.Message)"
    }
    if (-not ($Listeners -contains $HostAddress)) {
        throw "Port $Port is not listening on $HostAddress. Current listeners: $($Listeners -join ', ')"
    }
    "listening on $HostAddress`:$Port"
}

$Checks += Test-Step "Operator auth" {
    if (-not $OperatorKey) { throw "Missing data\auth.json operator token." }
    $State = Invoke-RestMethod -Uri "$BaseUrl/api/state" -Headers $Headers -TimeoutSec 5
    "$(($State.messages | Measure-Object).Count) messages, $(($State.tasks | Measure-Object).Count) tasks, $(($State.approvals | Measure-Object).Count) approvals, $(($State.executions | Measure-Object).Count) executions"
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
    $Git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $Git) { return "git not on PATH; skipped" }
    $Status = & $Git.Source -C $Root status --short --branch
    ($Status -join "; ")
}

$Checks += Test-Step "Listener stop detection" {
    $NetTcpListeners = @(Get-NetTCPConnection -LocalPort ([int]$Port) -State Listen -ErrorAction SilentlyContinue)
    $NetstatPids = @(netstat -ano |
        Select-String "LISTENING" |
        Where-Object { $_.Line -match "[:.]$Port\s+" } |
        ForEach-Object {
            $Parts = $_.Line.Trim() -split "\s+"
            [int]$Parts[-1]
        } |
        Select-Object -Unique)

    if (-not $NetTcpListeners -and $NetstatPids) {
        $StopScript = Join-Path $Root "Stop-Latch.ps1"
        $StopScriptText = if (Test-Path -LiteralPath $StopScript) { Get-Content -LiteralPath $StopScript -Raw } else { "" }
        if ($StopScriptText -notmatch "netstat" -or $StopScriptText -notmatch "LISTENING") {
            throw "Get-NetTCPConnection found no listener, but netstat found PID(s): $($NetstatPids -join ', '). Stop-Latch.ps1 fallback is required."
        }
        return "Get-NetTCPConnection unavailable, netstat fallback present; listener PID(s): $($NetstatPids -join ', ')"
    }
    if ($NetTcpListeners) {
        $Pids = $NetTcpListeners | Select-Object -ExpandProperty OwningProcess -Unique
        return "listener PID(s): $($Pids -join ', ')"
    }
    "no listener found on port $Port"
}

$Checks += Test-Step "Archived channel delete" {
    if (-not $OperatorKey) { throw "Missing operator token." }
    $Label = "Doctor delete probe $([guid]::NewGuid().ToString('N').Substring(0, 8))"
    $Created = Invoke-RestMethod -Uri "$BaseUrl/api/channels" -Method Post -Headers $Headers -ContentType "application/json" -Body (@{
        label = $Label
        description = "Temporary doctor delete probe"
    } | ConvertTo-Json)

    Invoke-RestMethod -Uri "$BaseUrl/api/channels/$($Created.id)" -Method Patch -Headers $Headers -ContentType "application/json" -Body (@{
        archived = $true
    } | ConvertTo-Json) | Out-Null

    $Deleted = Invoke-RestMethod -Uri "$BaseUrl/api/channels/$($Created.id)" -Method Delete -Headers $Headers
    if (-not $Deleted.ok) { throw "Delete returned an unexpected response." }

    $State = Invoke-RestMethod -Uri "$BaseUrl/api/state" -Headers $Headers -TimeoutSec 5
    if ($State.channels | Where-Object { $_.id -eq $Created.id }) { throw "Probe channel still appears in active channels." }
    if ($State.archives.channels | Where-Object { $_.id -eq $Created.id }) { throw "Probe channel still appears in archived channels." }
    if (-not ($State.meta.deletedRecords | Where-Object { $_ -eq "channels:$($Created.id)" })) { throw "Probe delete marker was not saved." }
    "created, archived, deleted, and verified $($Created.id)"
}

if ($VmHost) {
    $Checks += Test-Step "VM can reach Latch" {
        $Result = Invoke-OpenClawSsh "curl -fsS --max-time 10 $BaseUrl/api/health"
        if (-not ($Result -match "ok")) { throw "Unexpected health response: $Result" }
        "VM reached $BaseUrl"
    }

    $Checks += Test-Step "VM bridge service" {
        $Result = Invoke-OpenClawSsh "systemctl is-active latch-agent-bridge"
        if (($Result | Select-Object -First 1) -ne "active") { throw ($Result -join "; ") }
        "active"
    }

    $Checks += Test-Step "VM executor service" {
        $Result = Invoke-OpenClawSsh "systemctl is-active latch-agent-executor"
        if (($Result | Select-Object -First 1) -ne "active") { throw ($Result -join "; ") }
        "active"
    }

    $Checks += Test-Step "VM Playwright Firefox" {
        $Result = Invoke-OpenClawSsh "/opt/latch-agent-executor/bin/python - <<'PY'
import importlib.util
from pathlib import Path
package_ok = importlib.util.find_spec('playwright') is not None
venv_ok = Path('/opt/latch-agent-executor').exists()
known_browser_roots = [
    Path('/root/.cache/ms-playwright'),
    Path('/var/lib/latch-agent-executor/.cache/ms-playwright'),
    Path.home() / '.cache' / 'ms-playwright',
]
def can_stat(path):
    try:
        return path.exists()
    except PermissionError:
        return True

browser_hint = any(can_stat(path) for path in known_browser_roots)
if package_ok and venv_ok:
    print('playwright package present' + ('; browser cache visible' if browser_hint else '; browser cache not visible to ssh user'))
else:
    print('playwright runtime missing')
PY"
        if (-not ($Result -match "package present")) { throw ($Result -join "; ") }
        ($Result -join "; ")
    }
}

$Checks | Format-Table -AutoSize

if ($Checks | Where-Object { -not $_.Ok }) {
    exit 1
}

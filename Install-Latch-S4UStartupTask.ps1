#requires -RunAsAdministrator
<#
    Install the Latch startup task so it survives a REBOOT, without running as SYSTEM.

    Three installers register the same task name and overwrite each other (-Force). Pick one:

      Install-Latch-StartupTask.ps1        AtLogOn   · troel, Interactive, Limited
                                           Starts when you log in. Does not survive an unattended
                                           reboot — nothing runs until someone signs in.

      Install-Latch-S4UStartupTask.ps1     AtStartup · troel, S4U, Limited          <-- this file
                                           Starts at boot, as you, with no interactive session and
                                           no stored password. The recommended one.

      Install-Latch-SystemStartupTask.ps1  AtStartup · SYSTEM, ServiceAccount, Highest
                                           Starts at boot as the most privileged account on the
                                           machine. See "why not SYSTEM" below.

    WHY S4U RATHER THAN SYSTEM. Latch is the credential boundary: its whole job is to hold API keys,
    tokens and mailbox credentials so that nothing else has to. Running that process as SYSTEM gives
    it every right on the machine, which is the opposite of what it exists to do. It also changes who
    owns the files it writes — `data/` would fill with SYSTEM-owned files inside a repository owned
    by a user, and that exact mismatch is what produced `fatal: detected dubious ownership` and cost
    a night of Bureau's scheduled hunts on 2026-08-15.

    S4U ("service for user") gets the part that actually mattered — running at boot with no login and
    no password on disk — while the process stays you, unelevated. It is the same arrangement the
    LLMServer-Bureau task already uses on this machine, for the same reasons.

    Windows will ask for nothing: S4U means the task runs as your account WITHOUT storing your
    password. Registering it does need an elevated shell, which is why the #requires line is here.

      powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-Latch-S4UStartupTask.ps1
#>
param(
    [string]$HostAddress = "",

    [string]$Port = "",

    [string]$TaskName = "Latch Private Gateway"
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ScriptPath = Join-Path $Root "Start-Latch-Tailscale.ps1"
. (Join-Path $Root "Latch-Config.ps1")

$HostAddress = Resolve-LatchHostAddress -HostAddress $HostAddress
$Port = Resolve-LatchPort -Port $Port

if (-not (Test-Path -LiteralPath $ScriptPath)) {
    throw "Missing $ScriptPath"
}

$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`" -HostAddress `"$HostAddress`" -Port `"$Port`""

$Trigger = New-ScheduledTaskTrigger -AtStartup

# S4U: runs as this account, at boot, with no interactive session and no password stored anywhere.
# RunLevel Limited on purpose — Latch needs no elevation, and a credential boundary is the last thing
# that should ask for more rights than it uses.
$Principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType S4U `
    -RunLevel Limited

# ExecutionTimeLimit 0 = never stop it. This is load-bearing and easy to leave out: omitting the
# setting takes Task Scheduler's DEFAULT of PT72H, so a long-running server is killed after three
# days of perfectly healthy uptime — a stop with no error, no log line and no obvious cause. The
# AtLogOn installer beside this one omitted it; that is fixed there too.
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 10 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Description "Start Latch at boot as the operator (S4U, unelevated) on the Windows Tailscale IP for private OpenClaw worker access." `
    -Force | Out-Null

# Report what was actually registered rather than "done". The principal is the whole point of this
# variant, so a run that silently registered SYSTEM or Interactive should be visible immediately.
$task = Get-ScheduledTask -TaskName $TaskName
[PSCustomObject]@{
    TaskName           = $task.TaskName
    State              = $task.State
    RunAs              = $task.Principal.UserId
    LogonType          = $task.Principal.LogonType
    RunLevel           = $task.Principal.RunLevel
    Trigger            = ($task.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ","
    ExecutionTimeLimit = $task.Settings.ExecutionTimeLimit
} | Format-List

Write-Host ""
Write-Host "Registered. It fires at the next boot; the running instance is untouched." -ForegroundColor Green
Write-Host "Note: Start-Latch-Tailscale.ps1 KILLS whatever holds the port before starting, so do not" -ForegroundColor DarkGray
Write-Host "press Run in Task Scheduler while Latch is up unless you mean to restart it." -ForegroundColor DarkGray

#requires -RunAsAdministrator
<#
    Install the Latch startup task so it survives a REBOOT *and* a Fast Startup resume, without
    running as SYSTEM.

    Three installers register the same task name and overwrite each other (-Force). Pick one:

      Install-Latch-StartupTask.ps1        AtLogOn · troel, Interactive, Limited
                                           SUPERSEDED. This file now carries a logon trigger of its
                                           own, so that one adds nothing and subtracts the boot
                                           trigger: running it replaces the task below with a
                                           logon-only, non-S4U version, silently and with -Force.

      Install-Latch-S4UStartupTask.ps1     AtStartup + AtLogOn · troel, S4U, Limited   <-- this file
                                           Starts at boot, as you, with no interactive session and
                                           no stored password — and again at logon, so a Fast
                                           Startup resume is covered too. The recommended one.

      Install-Latch-SystemStartupTask.ps1  AtStartup · SYSTEM, ServiceAccount, Highest
                                           Starts at boot as the most privileged account on the
                                           machine. See "why not SYSTEM" below.

    WHY TWO TRIGGERS, when starting at boot was the whole point of S4U. Because on this machine a
    boot mostly does not happen. Fast Startup is on (HiberbootEnabled=1), so "Shut down" hibernates
    the kernel session instead of ending it, and the next power-on RESUMES that session: the kernel
    logs boot type 0x1, uptime keeps counting from the last real boot, and nothing starts. An
    AtStartup trigger fires on none of it. Only "Restart" forces a full boot.

    Measured 2026-08-18: shut down at 22:37:29 from the Start menu, powered back on five seconds
    later. Every user process died with the session — Latch and Bureau both — and neither came back,
    while uptime still read 2026-08-13. This task, registered the evening before, had at that point
    never fired once: the last full boot predated its existence by four days.

    AtLogOn closes the gap, because a Fast Startup resume still logs you on. The pair means an
    unattended real boot starts Latch before anyone signs in, and every other route back to a
    desktop starts it at sign-in.

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

# Two triggers on one task; Register-ScheduledTask takes an array. The logon trigger is scoped to
# this account rather than left to fire for any user, because the principal runs as this account —
# an unscoped trigger would start the credential boundary off somebody else's sign-in.
$Trigger = @(
    (New-ScheduledTaskTrigger -AtStartup),
    (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME)
)

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
#
# MultipleInstances IgnoreNew matters once there are two triggers: a genuine full boot fires BOTH,
# AtStartup bringing Latch up and then the logon following it minutes later. The action runs node in
# the FOREGROUND, so the first task instance is still alive at that point, and
# Start-Latch-Tailscale.ps1 KILLS whatever holds the port before it starts. A second instance would
# therefore stop a healthy credential boundary and restart it at the moment you sit down.
#
# IgnoreNew was verified to be the current default (2026-08-19), so this line changes nothing today.
# It is written down anyway, for the reason immediately above it: this task has already lost three
# days of uptime to a default that was correct until it wasn't, and never stated anywhere.
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -RestartCount 10 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Description "Start Latch at boot AND at logon as the operator (S4U, unelevated) on the Windows Tailscale IP for private OpenClaw worker access. The logon trigger is what covers a Fast Startup resume, which is not a boot and fires no boot trigger." `
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
    Triggers           = ($task.Triggers | ForEach-Object {
                             $kind = $_.CimClass.CimClassName -replace '^MSFT_Task', '' -replace 'Trigger$', ''
                             if ($_.UserId) { "$kind($($_.UserId))" } else { $kind }
                         }) -join " + "
    MultipleInstances  = $task.Settings.MultipleInstances
    ExecutionTimeLimit = $task.Settings.ExecutionTimeLimit
} | Format-List

# A report is only worth printing if something reads it. Both triggers are the entire point of this
# revision, and a task carrying just one of them looks perfectly healthy at a glance — State Ready,
# RunAs correct, no error anywhere — so the pair is asserted rather than left to the eye. Losing the
# logon trigger would restore exactly the failure this file was revised to fix, silently.
$kinds   = @($task.Triggers | ForEach-Object { $_.CimClass.CimClassName })
$missing = @("MSFT_TaskBootTrigger", "MSFT_TaskLogonTrigger") | Where-Object { $kinds -notcontains $_ }
if ($missing) {
    Write-Host ""
    # ASCII only in this string, deliberately. This file is UTF-8 WITHOUT a BOM, so Windows
    # PowerShell 5.1 decodes it as CP1252: an em dash becomes three characters, the last of which is
    # U+201D, and PowerShell accepts U+201D as a closing quote. One em dash inside a live string
    # therefore ends it early and the rest of the file stops parsing. Em dashes are safe in the
    # <# #> and # comments above, which is why the eight already in this file have never mattered.
    Write-Host "REGISTERED, BUT INCOMPLETE - missing: $($missing -join ', ')" -ForegroundColor Red
    Write-Host "Latch will not start on whichever route that trigger covered. Re-run this script, or" -ForegroundColor Red
    Write-Host "add the trigger by hand in Task Scheduler before relying on it." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Both triggers present: boot (unattended restart) and logon (covers a Fast Startup resume)." -ForegroundColor Green
Write-Host "Registered. It fires at the next boot OR the next logon, whichever comes first; the" -ForegroundColor Green
Write-Host "running instance is untouched." -ForegroundColor Green
Write-Host "Note: Start-Latch-Tailscale.ps1 KILLS whatever holds the port before starting, so do not" -ForegroundColor DarkGray
Write-Host "press Run in Task Scheduler while Latch is up unless you mean to restart it." -ForegroundColor DarkGray

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
$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet `
    -RestartCount 10 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Days 0)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Description "Start Latch on the Windows Tailscale IP for private OpenClaw worker access." `
    -Force

Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State

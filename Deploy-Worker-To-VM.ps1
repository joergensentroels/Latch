param(
    [string]$VmHost = "",

    [string]$VmUser = "latchsetup",

    [string]$KeyPath = "$env:USERPROFILE\.ssh\latchsetup_openclaw_vm_codex",

    [switch]$BridgeOnly,

    [switch]$ExecutorOnly,

    [switch]$VerifyOnly,

    [switch]$Activate,

    [switch]$InteractiveSudo,

    [switch]$InteractiveWindow,

    [switch]$RunDoctor,

    [string]$HostAddress = "",

    [string]$Port = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$DeployScript = Join-Path $Root "Deploy-Bridge-To-VM.ps1"

function Quote-Argument {
    param([string]$Value)
    if ($Value -match '^[A-Za-z0-9_./:=@-]+$') {
        return $Value
    }
    return '"' + ($Value -replace '"', '\"') + '"'
}

$ForwardArgs = @(
    "-ExecutionPolicy", "Bypass",
    "-File", $DeployScript,
    "-VmHost", $VmHost,
    "-VmUser", $VmUser,
    "-KeyPath", $KeyPath
)

if ($BridgeOnly) { $ForwardArgs += "-BridgeOnly" }
if ($ExecutorOnly) { $ForwardArgs += "-ExecutorOnly" }
if ($VerifyOnly) { $ForwardArgs += "-VerifyOnly" }
if ($Activate) { $ForwardArgs += "-Activate" }
if ($InteractiveSudo -or $InteractiveWindow) { $ForwardArgs += "-InteractiveSudo" }
if ($RunDoctor) { $ForwardArgs += "-RunDoctor" }
if ($HostAddress) { $ForwardArgs += @("-HostAddress", $HostAddress) }
if ($Port) { $ForwardArgs += @("-Port", $Port) }

if ($InteractiveWindow) {
    Write-Output "Opening a visible PowerShell window for deploy and sudo prompts."
    Write-Output "Close that window when the deploy is finished if it remains open."
    $ArgumentLine = ($ForwardArgs | ForEach-Object { Quote-Argument $_ }) -join " "
    $Process = Start-Process -FilePath "powershell" -ArgumentList $ArgumentLine -Wait -PassThru
    if ($Process.ExitCode -ne 0) {
        throw "Interactive deploy window exited with code $($Process.ExitCode)."
    }
    return
}

& powershell @ForwardArgs

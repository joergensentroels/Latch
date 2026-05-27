param(
    [string]$VmHost = "",

    [string]$VmUser = "latchsetup",

    [string]$KeyPath = "$env:USERPROFILE\.ssh\latchsetup_openclaw_vm_codex",

    [switch]$BridgeOnly,

    [switch]$ExecutorOnly,

    [switch]$VerifyOnly,

    [switch]$Activate,

    [switch]$InteractiveSudo,

    [switch]$RunDoctor,

    [string]$HostAddress = "",

    [string]$Port = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$WorkerRoot = Join-Path $Root "worker"
$RemoteDir = "~/latch-worker-next"
$SshTarget = "$VmUser@$VmHost"

if (!$VmHost) {
    throw "Missing -VmHost. Example: powershell -ExecutionPolicy Bypass -File .\Deploy-Bridge-To-VM.ps1 -VmHost <openclaw-vm-tailscale-ip>"
}

if ($BridgeOnly -and $ExecutorOnly) {
    throw "Use either -BridgeOnly or -ExecutorOnly, not both."
}

if (!(Test-Path -LiteralPath $KeyPath)) {
    throw "SSH key not found: $KeyPath"
}

$BridgeFiles = @(
    "latch-agent-bridge.py",
    "latch-agent-bridge.service",
    "latch-agent-bridge.env.example",
    "install-latch-agent-bridge.sh"
)

$ExecutorFiles = @(
    "latch-agent-executor.py",
    "latch-agent-executor.service",
    "latch-agent-executor.env.example",
    "install-latch-agent-executor.sh"
)

$Files = @()
if (!$ExecutorOnly) {
    $Files += $BridgeFiles
}
if (!$BridgeOnly) {
    $Files += $ExecutorFiles
}

foreach ($File in $Files) {
    $Path = Join-Path $WorkerRoot $File
    if (!(Test-Path -LiteralPath $Path)) {
        throw "Worker file not found: $Path"
    }
}

function Invoke-Ssh {
    param(
        [string]$Command,
        [switch]$Tty
    )

    $SshArgs = @("-i", $KeyPath, "-o", "StrictHostKeyChecking=accept-new")
    if ($Tty) {
        $SshArgs += "-tt"
    }
    $SshArgs += @($SshTarget, $Command)
    & ssh @SshArgs
    if ($LASTEXITCODE -ne 0) {
        throw "SSH command failed with exit code $LASTEXITCODE."
    }
}

if (!$VerifyOnly) {
    Write-Output "Preparing $RemoteDir on $SshTarget"
    Invoke-Ssh "mkdir -p $RemoteDir"

    foreach ($File in $Files) {
        $Path = Join-Path $WorkerRoot $File
        Write-Output "Copying $File to $SshTarget`:$RemoteDir/"
        & scp -i $KeyPath -o StrictHostKeyChecking=accept-new $Path "$SshTarget`:$RemoteDir/"
        if ($LASTEXITCODE -ne 0) {
            throw "Copy failed for $File with exit code $LASTEXITCODE."
        }
    }
}

$Sudo = if ($InteractiveSudo) { "sudo" } else { "sudo -n" }
$ActivationCommands = @("cd ~/latch-worker-next")
$RestartServices = @()
if (!$ExecutorOnly) {
    $ActivationCommands += "$Sudo install -o root -g root -m 0755 latch-agent-bridge.py /usr/local/bin/latch-agent-bridge.py"
    $ActivationCommands += "$Sudo install -o root -g root -m 0644 latch-agent-bridge.service /etc/systemd/system/latch-agent-bridge.service"
    $RestartServices += "latch-agent-bridge"
}
if (!$BridgeOnly) {
    $ActivationCommands += "$Sudo install -o root -g root -m 0755 latch-agent-executor.py /usr/local/bin/latch-agent-executor.py"
    $ActivationCommands += "$Sudo install -o root -g root -m 0644 latch-agent-executor.service /etc/systemd/system/latch-agent-executor.service"
    $RestartServices += "latch-agent-executor"
}
if ($RestartServices.Count -gt 0) {
    $ActivationCommands += "$Sudo systemctl daemon-reload"
    $ActivationCommands += "$Sudo systemctl restart $($RestartServices -join ' ')"
    foreach ($Service in $RestartServices) {
        $ActivationCommands += "$Sudo systemctl status $Service --no-pager"
    }
}

if ($Activate) {
    Write-Output ""
    Write-Output "Activating copied worker files on $SshTarget"
    try {
        Invoke-Ssh ($ActivationCommands -join " && ") -Tty:$InteractiveSudo
    } catch {
        if (!$InteractiveSudo) {
            Write-Output ""
            Write-Output "Activation failed. If sudo requires a password on the VM, rerun with -InteractiveSudo."
        }
        throw
    }
} else {
    Write-Output ""
    Write-Output "Run these on the VM to activate the copied worker files, or rerun this script with -Activate:"
    foreach ($Command in $ActivationCommands) {
        Write-Output "  $Command"
    }
}

Write-Output ""
Write-Output "Current VM service status:"
if (!$ExecutorOnly) {
    Invoke-Ssh "systemctl is-active latch-agent-bridge; systemctl show latch-agent-bridge --property=ActiveState,SubState,ExecMainPID,ExecMainStatus,NRestarts"
}
if (!$BridgeOnly) {
    Invoke-Ssh "systemctl is-active latch-agent-executor; systemctl show latch-agent-executor --property=ActiveState,SubState,ExecMainPID,ExecMainStatus,NRestarts"
}

if (!$ExecutorOnly) {
    Write-Output ""
    Write-Output "Installed bridge channel-routing probe:"
    Invoke-Ssh "PYTHONDONTWRITEBYTECODE=1 python3 - <<'PY'
import importlib.util
import sys
spec = importlib.util.spec_from_file_location('bridge', '/usr/local/bin/latch-agent-bridge.py')
mod = importlib.util.module_from_spec(spec)
sys.modules['bridge'] = mod
spec.loader.exec_module(mod)
print(mod.requested_latch_channel('Send a message in the operations channel', [{'id':'compass','label':'Compass'}, {'id':'operations','label':'Operations'}]))
PY"
}

if ($RunDoctor) {
    Write-Output ""
    Write-Output "Running Latch doctor:"
    $DoctorPath = Join-Path $Root "Invoke-Latch-Doctor.ps1"
    $DoctorArgs = @("-ExecutionPolicy", "Bypass", "-File", $DoctorPath, "-VmHost", $VmHost, "-VmUser", $VmUser, "-KeyPath", $KeyPath)
    if ($HostAddress) {
        $DoctorArgs += @("-HostAddress", $HostAddress)
    }
    if ($Port) {
        $DoctorArgs += @("-Port", $Port)
    }
    & powershell @DoctorArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Latch doctor failed with exit code $LASTEXITCODE."
    }
}

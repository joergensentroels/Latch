param(
    [string]$VmHost = "",

    [string]$VmUser = "latchsetup",

    [string]$KeyPath = "$env:USERPROFILE\.ssh\latchsetup_openclaw_vm_codex",

    [switch]$VerifyOnly
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$BridgePath = Join-Path $Root "worker\latch-agent-bridge.py"
$RemoteNext = "~/latch-agent-bridge.py.next"
$SshTarget = "$VmUser@$VmHost"

if (!(Test-Path -LiteralPath $BridgePath)) {
    throw "Bridge script not found: $BridgePath"
}

if (!$VmHost) {
    throw "Missing -VmHost. Example: powershell -ExecutionPolicy Bypass -File .\Deploy-Bridge-To-VM.ps1 -VmHost <openclaw-vm-tailscale-ip>"
}

if (!(Test-Path -LiteralPath $KeyPath)) {
    throw "SSH key not found: $KeyPath"
}

function Invoke-Ssh {
    param([string]$Command)
    & ssh -i $KeyPath -o StrictHostKeyChecking=accept-new $SshTarget $Command
}

if (!$VerifyOnly) {
    Write-Output "Copying bridge script to $SshTarget`:$RemoteNext"
    & scp -i $KeyPath -o StrictHostKeyChecking=accept-new $BridgePath "$SshTarget`:$RemoteNext"
}

Write-Output ""
Write-Output "Run these on the VM to activate the copied bridge:"
Write-Output "  sudo install -o root -g root -m 0755 ~/latch-agent-bridge.py.next /usr/local/bin/latch-agent-bridge.py"
Write-Output "  sudo systemctl restart latch-agent-bridge"
Write-Output "  sudo systemctl status latch-agent-bridge --no-pager"
Write-Output ""
Write-Output "Current VM bridge status:"
Invoke-Ssh "systemctl is-active latch-agent-bridge; systemctl show latch-agent-bridge --property=ActiveState,SubState,ExecMainPID,ExecMainStatus,NRestarts"
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

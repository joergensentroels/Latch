param(
    [string]$Remote = "origin",

    [string]$Branch = "",

    [string]$VmHost = "",

    [string]$HostAddress = "",

    [string]$VmUser = "latchsetup",

    [string]$KeyPath = "$env:USERPROFILE\.ssh\latchsetup_openclaw_vm_codex",

    [switch]$NoDeploy,

    [switch]$AllowDirtyDeploy,

    [switch]$NoDoctor,

    [switch]$InteractiveWindow,

    [switch]$InteractiveSudo
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

if (!$VmHost) {
    throw "Missing -VmHost. Example: powershell -ExecutionPolicy Bypass -File .\Push-And-Deploy.ps1 -VmHost <openclaw-vm-tailscale-ip> -HostAddress <windows-tailscale-ip> -InteractiveWindow"
}

function Resolve-Git {
    $Git = Get-Command git -ErrorAction SilentlyContinue
    if ($Git -and $Git.Source) {
        return $Git.Source
    }

    $Candidates = @(
        "$env:LOCALAPPDATA\GitHubDesktop\bin\git.exe",
        "$env:ProgramFiles\Git\cmd\git.exe",
        "${env:ProgramFiles(x86)}\Git\cmd\git.exe"
    )

    foreach ($Candidate in $Candidates) {
        if ($Candidate -and (Test-Path -LiteralPath $Candidate)) {
            return $Candidate
        }
    }

    throw "Git was not found on PATH or in common install locations."
}

$GitExe = Resolve-Git
$CurrentBranch = (& $GitExe rev-parse --abbrev-ref HEAD).Trim()
if (!$Branch) {
    $Branch = $CurrentBranch
}
if (!$Branch -or $Branch -eq "HEAD") {
    throw "Could not determine the current branch. Pass -Branch explicitly."
}

if (!$NoDeploy -and !$AllowDirtyDeploy) {
    $Dirty = & $GitExe status --porcelain
    if ($Dirty) {
        Write-Output "Working tree has uncommitted changes:"
        $Dirty | ForEach-Object { Write-Output "  $_" }
        throw "Refusing to deploy dirty local files after push. Commit/stash changes first, or rerun with -AllowDirtyDeploy for an explicit hot deploy."
    }
}

Write-Output "Pushing $Branch to $Remote..."
& $GitExe push $Remote $Branch
if ($LASTEXITCODE -ne 0) {
    throw "git push failed with exit code $LASTEXITCODE. Worker deploy was not run."
}

if ($NoDeploy) {
    Write-Output "Push succeeded. Skipping worker deploy because -NoDeploy was set."
    exit 0
}

$DeployScript = Join-Path $Root "Deploy-Worker-To-VM.ps1"
$DeployArgs = @(
    "-ExecutionPolicy", "Bypass",
    "-File", $DeployScript,
    "-VmHost", $VmHost,
    "-HostAddress", $HostAddress,
    "-VmUser", $VmUser,
    "-KeyPath", $KeyPath,
    "-Activate"
)

if (!$NoDoctor) {
    $DeployArgs += "-RunDoctor"
}
if ($InteractiveWindow) {
    $DeployArgs += "-InteractiveWindow"
} elseif ($InteractiveSudo) {
    $DeployArgs += "-InteractiveSudo"
}

Write-Output "Push succeeded. Deploying OpenClaw worker..."
& powershell @DeployArgs
if ($LASTEXITCODE -ne 0) {
    throw "Worker deploy failed with exit code $LASTEXITCODE."
}

Write-Output "Push and deploy completed."

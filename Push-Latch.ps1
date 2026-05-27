param(
    [string]$Message = "",

    [string]$Remote = "origin",

    [string]$Branch = "",

    [switch]$Yes,

    [switch]$DryRun,

    [switch]$NoPush,

    [switch]$SkipPull,

    [switch]$AllowSensitivePaths
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

function Resolve-Git {
    $Git = Get-Command git -ErrorAction SilentlyContinue
    if ($Git -and $Git.Source) {
        return $Git.Source
    }

    $Candidates = @(
        "$env:LOCALAPPDATA\GitHubDesktop\bin\git.exe",
        "$env:LOCALAPPDATA\GitHubDesktop\app-*\resources\app\git\mingw64\bin\git.exe",
        "$env:ProgramFiles\Git\cmd\git.exe",
        "${env:ProgramFiles(x86)}\Git\cmd\git.exe"
    )

    foreach ($Candidate in $Candidates) {
        if (!$Candidate) {
            continue
        }

        $Matches = Get-ChildItem -Path $Candidate -ErrorAction SilentlyContinue | Sort-Object FullName -Descending
        foreach ($Match in $Matches) {
            if ($Match -and (Test-Path -LiteralPath $Match.FullName)) {
                return $Match.FullName
            }
        }
    }

    throw "Git was not found on PATH or in common install locations."
}

$GitExe = Resolve-Git

function Read-Git {
    param([string[]]$GitArgs)

    $Output = & $GitExe @GitArgs
    if ($LASTEXITCODE -ne 0) {
        throw "git $($GitArgs -join ' ') failed with exit code $LASTEXITCODE."
    }
    return $Output
}

function Invoke-Git {
    param([string[]]$GitArgs)

    & $GitExe @GitArgs
    if ($LASTEXITCODE -ne 0) {
        throw "git $($GitArgs -join ' ') failed with exit code $LASTEXITCODE."
    }
}

$InsideWorkTree = (Read-Git @("rev-parse", "--is-inside-work-tree")).Trim()
if ($InsideWorkTree -ne "true") {
    throw "This script must be run from inside the Latch git repository."
}

$TopLevel = (Read-Git @("rev-parse", "--show-toplevel")).Trim()
$ResolvedRoot = (Resolve-Path -LiteralPath $Root).Path
$ResolvedTopLevel = (Resolve-Path -LiteralPath $TopLevel).Path
if ($ResolvedRoot -ne $ResolvedTopLevel) {
    throw "This script is in $ResolvedRoot, but git repo root is $ResolvedTopLevel."
}

if (!$Branch) {
    $Branch = (Read-Git @("rev-parse", "--abbrev-ref", "HEAD")).Trim()
}
if (!$Branch -or $Branch -eq "HEAD") {
    throw "Could not determine the current branch. Pass -Branch explicitly."
}

$RemoteUrl = (Read-Git @("remote", "get-url", $Remote)).Trim()
$Status = Read-Git @("status", "--short")

Write-Output "Latch repository: $ResolvedRoot"
Write-Output "Git executable: $GitExe"
Write-Output "Remote: $Remote ($RemoteUrl)"
Write-Output "Branch: $Branch"

if (!$Status) {
    Write-Output "No local changes to commit or push."
    exit 0
}

Write-Output ""
Write-Output "Local changes:"
$Status | ForEach-Object { Write-Output "  $_" }

if ($DryRun) {
    Write-Output ""
    Write-Output "Dry run only. Nothing was staged, committed, or pushed."
    exit 0
}

if (!$Yes) {
    Write-Output ""
    $Answer = Read-Host "Type PUSH to stage, commit, and push these changes"
    if ($Answer -ne "PUSH") {
        throw "Cancelled. No changes were staged, committed, or pushed."
    }
}

Invoke-Git @("add", "-A")

$StagedNames = Read-Git @("diff", "--cached", "--name-only")
if (!$StagedNames) {
    Write-Output "No staged changes after git add. Nothing to commit."
    exit 0
}

$SensitivePattern = '(^|/)(\.env[^/]*|data|data-dev)(/|$)|(^|/).*(secret|token|password|credential|private).*$|.*\.(pem|key|pfx|p12)$'
$SensitiveNames = $StagedNames | Where-Object { $_ -match $SensitivePattern }
if ($SensitiveNames -and !$AllowSensitivePaths) {
    Write-Output ""
    Write-Output "Refusing to commit paths that look sensitive:"
    $SensitiveNames | ForEach-Object { Write-Output "  $_" }
    throw "Review these paths, update .gitignore if needed, or rerun with -AllowSensitivePaths if this is intentional."
}

Write-Output ""
Write-Output "Staged files:"
$StagedNames | ForEach-Object { Write-Output "  $_" }

if (!$Message) {
    $Message = "Update Latch $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
}

Invoke-Git @("commit", "-m", $Message)

if ($NoPush) {
    Write-Output "Commit created. Skipping push because -NoPush was set."
    exit 0
}

if (!$SkipPull) {
    Write-Output "Rebasing latest $Remote/$Branch before push..."
    Invoke-Git @("pull", "--rebase", $Remote, $Branch)
}

Write-Output "Pushing $Branch to $Remote..."
Invoke-Git @("push", $Remote, $Branch)

Write-Output "Latch changes committed and pushed."

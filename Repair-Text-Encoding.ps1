param(
    [string]$DbPath = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $DbPath) {
    $DbPath = Join-Path $Root "data\db.json"
}

if (-not (Test-Path -LiteralPath $DbPath)) {
    throw "Database not found at $DbPath"
}

function S {
    param([int[]]$Codepoints)
    return -join ($Codepoints | ForEach-Object { [char]$_ })
}

$Raw = Get-Content -LiteralPath $DbPath -Raw
$BackupPath = "$DbPath.encoding-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item -LiteralPath $DbPath -Destination $BackupPath

$Pairs = @(
    @((S @(0x00E2, 0x20AC, 0x2122)), "'"),
    @((S @(0x00E2, 0x20AC, 0x02DC)), "'"),
    @((S @(0x00E2, 0x20AC, 0x0153)), '"'),
    @((S @(0x00E2, 0x20AC, 0x009D)), '"'),
    @((S @(0x00E2, 0x20AC, 0x009D)), '"'),
    @((S @(0x00E2, 0x20AC, 0x201C)), "-"),
    @((S @(0x00E2, 0x20AC, 0x201D)), "-"),
    @((S @(0x00E2, 0x20AC, 0x00A6)), "..."),
    @((S @(0x00E2, 0x20AC, 0x00A2)), "-"),
    @((S @(0x00C2, 0x0020)), " "),
    @((S @(0x00C2)), "")
)

$Fixed = $Raw
foreach ($Pair in $Pairs) {
    $Fixed = $Fixed.Replace([string]$Pair[0], [string]$Pair[1])
}

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($DbPath, $Fixed, $Utf8NoBom)

[PSCustomObject]@{
    DbPath = $DbPath
    BackupPath = $BackupPath
    Changed = ($Fixed -ne $Raw)
}

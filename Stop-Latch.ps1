param(
    [int]$Port = 8787
)

$ErrorActionPreference = "Stop"

$Listeners = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq "Listen" }

$NetstatProcessIds = @()
if (-not $Listeners) {
    $NetstatProcessIds = netstat -ano |
        Select-String "LISTENING" |
        Where-Object { $_.Line -match "[:.]$Port\s+" } |
        ForEach-Object {
            $Parts = $_.Line.Trim() -split "\s+"
            [int]$Parts[-1]
        } |
        Select-Object -Unique
}

if (-not $Listeners) {
    if (-not $NetstatProcessIds) {
        Write-Output "Latch is not listening on port $Port."
        exit 0
    }
    $ProcessIds = $NetstatProcessIds
} else {
    $ProcessIds = $Listeners | Select-Object -ExpandProperty OwningProcess -Unique
}

foreach ($ProcessId in $ProcessIds) {
    $Process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($Process -and $Process.ProcessName -eq "node") {
        Stop-Process -Id $Process.Id -Force
        Write-Output "Stopped Latch process $($Process.Id) on port $Port."
    } else {
        Write-Output "Skipping non-Node listener PID $ProcessId on port $Port."
    }
}

param(
    [int]$Port = 8787
)

$ErrorActionPreference = "Stop"

$Listeners = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq "Listen" }

if (-not $Listeners) {
    Write-Output "Latch is not listening on port $Port."
    exit 0
}

$ProcessIds = $Listeners | Select-Object -ExpandProperty OwningProcess -Unique

foreach ($ProcessId in $ProcessIds) {
    $Process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($Process -and $Process.ProcessName -eq "node") {
        Stop-Process -Id $Process.Id -Force
        Write-Output "Stopped Latch process $($Process.Id) on port $Port."
    } else {
        Write-Output "Skipping non-Node listener PID $ProcessId on port $Port."
    }
}

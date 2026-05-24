param(
    [string]$HostAddress = "",

    [string]$Port = ""
)

$ErrorActionPreference = "Stop"

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "Latch-Config.ps1")

$HostAddress = Resolve-LatchHostAddress -HostAddress $HostAddress
$Port = Resolve-LatchPort -Port $Port

$Targets = @("127.0.0.1", $HostAddress) | Select-Object -Unique
$Checks = foreach ($Target in $Targets) {
    $Url = "http://$Target`:$Port/api/health"
    try {
        $Health = Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 3
        [PSCustomObject]@{
            Url = $Url
            Ok = [bool]$Health.ok
            App = $Health.app
            Error = $null
        }
    } catch {
        [PSCustomObject]@{
            Url = $Url
            Ok = $false
            App = $null
            Error = $_.Exception.Message
        }
    }
}

[PSCustomObject]@{
    Listening = [bool]($Checks | Where-Object { $_.Ok })
    Checks = $Checks
    LanUrl = "http://$HostAddress`:$Port"
    LocalUrl = "http://127.0.0.1:$Port"
}

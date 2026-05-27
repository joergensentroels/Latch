param(
  [string]$Owner = "",
  [string]$DefaultRepo = "",
  [ValidateSet("user", "org")]
  [string]$OwnerType = "user",
  [ValidateSet("private", "public")]
  [string]$DefaultVisibility = "private",
  [string]$ApiBaseUrl = "https://api.github.com",
  [switch]$NoAutoInit,
  [switch]$PromptForToken
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = Join-Path $root "data"
$configPath = Join-Path $dataDir "github.json"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$existing = @{}
if (Test-Path $configPath) {
  try {
    $existing = Get-Content -Raw -Path $configPath | ConvertFrom-Json
  } catch {
    $existing = @{}
  }
}

$token = ""
if ($existing.PSObject.Properties.Name -contains "token") {
  $token = [string]$existing.token
}
if ($PromptForToken -or -not $token) {
  $secureToken = Read-Host "GitHub fine-grained token" -AsSecureString
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  )
}

if (-not $Owner -and ($existing.PSObject.Properties.Name -contains "owner") -and $existing.owner) {
  $Owner = [string]$existing.owner
}
if (-not $DefaultRepo -and ($existing.PSObject.Properties.Name -contains "defaultRepo") -and $existing.defaultRepo) {
  $DefaultRepo = [string]$existing.defaultRepo
}

$config = [ordered]@{
  apiBaseUrl = $ApiBaseUrl
  token = $token
  owner = $Owner
  defaultRepo = $DefaultRepo
  ownerType = $OwnerType
  defaultVisibility = $DefaultVisibility
  autoInit = -not $NoAutoInit
  timeoutMs = 15000
  updatedAt = (Get-Date).ToUniversalTime().ToString("o")
}

$json = $config | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($configPath, $json, [System.Text.UTF8Encoding]::new($false))
Write-Host "GitHub connector saved to $configPath"
Write-Host "Restart Latch if it is already running."

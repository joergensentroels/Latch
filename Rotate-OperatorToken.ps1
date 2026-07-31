# Rotate the operator token.
#
# The operator token is the whole authority boundary: it gates Latch's /api, gates Bureau's /api and /mcp,
# and can approve the hard-floored actions (shell, api_call, email, MCP calls). On this deployment it is
# effectively shell access on the host. There was no documented way to roll it, which means in practice it
# had never been rolled.
#
#   .\Rotate-OperatorToken.ps1 -WhatIf     # show exactly what would change, touch nothing
#   .\Rotate-OperatorToken.ps1             # rotate (asks for confirmation)
#
# If that fails with UnauthorizedAccess, this machine's LocalMachine execution policy is Restricted. Use a
# per-process bypass rather than changing machine policy:
#   powershell -NoProfile -ExecutionPolicy Bypass -File "<this path>"
#
# THE TRAP THIS SCRIPT EXISTS TO PREVENT: Bureau reads Latch's auth.json ONCE, at boot, and caches the
# token in memory. So rotating the file and stopping there leaves the OLD token still working against
# Bureau on :4173 - you would have every reason to believe you had rotated, and you would not have. The
# restart checklist below is not optional politeness; it is the second half of the rotation.
#
# This file is deliberately pure ASCII. PowerShell 5.1 reads a .ps1 with no BOM as CP1252, so a UTF-8
# em-dash (E2 80 94) decodes as three characters ending in 0x94 - a RIGHT DOUBLE QUOTE, which terminates
# whatever string it sits in and spills the rest of the line out as code. That is not theoretical: it is
# how the first version of this script printed `-ForegroundColor Red` as literal text.
#
# The new token is deliberately NOT printed. Read it the way this repo already expects:
#   .\Show-CommandCenter-Keys.ps1
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "High")]
param(
  # Overridable so the script can be exercised against a copy instead of the live credential store.
  [string]$DataDir = (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "data")
)

$ErrorActionPreference = "Stop"
$authPath = Join-Path $DataDir "auth.json"

if (-not (Test-Path $authPath)) {
  Write-Host "No auth.json at $authPath" -ForegroundColor Red
  Write-Host "Nothing to rotate. Latch generates one on first boot."
  exit 1
}

# Strip a UTF-8 BOM before parsing. Not hypothetical: two config files in this data directory carry one,
# because PowerShell's Set-Content and Out-File add it by default, and it made Latch silently ignore
# notifications.json for weeks. A rotation script that choked on its own encoding would be a poor joke.
# [char]0xFEFF rather than a literal BOM in the source: under CP1252 that literal decodes to three
# different characters, so the pattern would silently stop matching the thing it is named for.
$raw = [System.IO.File]::ReadAllText($authPath) -replace "^$([char]0xFEFF)", ""
try { $auth = $raw | ConvertFrom-Json } catch {
  Write-Host "auth.json is not valid JSON - refusing to overwrite it." -ForegroundColor Red
  Write-Host "  $($_.Exception.Message)"
  exit 1
}
if (-not $auth.operatorToken) {
  Write-Host "auth.json has no operatorToken field - refusing to guess at its shape." -ForegroundColor Red
  exit 1
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = Join-Path $DataDir "backups"
$backupPath = Join-Path $backupDir "auth-before-rotation-$stamp.json"

# Same generator Latch uses for the token it creates on first boot (server.js: op_ + 24 random bytes,
# base64url), so a rotated token is indistinguishable in shape from an original one.
$bytes = New-Object byte[] 24
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$newToken = "op_" + ([Convert]::ToBase64String($bytes) -replace '\+', '-' -replace '/', '_' -replace '=', '')

Write-Host "Rotating the operator token in $authPath"
Write-Host "  current: $($auth.operatorToken.Substring(0,6))...  ($($auth.operatorToken.Length) chars)"
Write-Host "  new    : $($newToken.Substring(0,6))...  ($($newToken.Length) chars)   (not shown in full - use .\Show-CommandCenter-Keys.ps1)"
Write-Host "  backup : $backupPath"
Write-Host "  agentToken and draftToken are PRESERVED - this rotates the operator token only." -ForegroundColor DarkGray

if (-not $PSCmdlet.ShouldProcess($authPath, "Replace operatorToken (backup first)")) {
  Write-Host "`nWhatIf: nothing written." -ForegroundColor Cyan
  exit 0
}

New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
Copy-Item -LiteralPath $authPath -Destination $backupPath -Force

$auth.operatorToken = $newToken
# Recorded so a later "when was this last rolled?" has an answer in the file itself rather than in
# somebody's memory. Add-Member because the field does not exist on a never-rotated auth.json.
if ($auth.PSObject.Properties.Name -contains "rotatedAt") { $auth.rotatedAt = (Get-Date).ToString("o") }
else { $auth | Add-Member -NotePropertyName rotatedAt -NotePropertyValue (Get-Date).ToString("o") }

# WriteAllText with a BOM-less UTF8Encoding, NOT Set-Content/Out-File. In PowerShell 5.1 those write a
# BOM, and node's JSON.parse rejects a leading U+FEFF - this script would have broken the very
# authentication it was rotating, in the same way notifications.json was already broken.
$json = $auth | ConvertTo-Json -Depth 10
$tmp = "$authPath.rotate-$PID.tmp"
[System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))

# Verify the TEMP file parses before it becomes auth.json. If this write were wrong, the alternative is a
# Latch that cannot authenticate anyone, on a host whose recovery path is that same authentication.
$check = [System.IO.File]::ReadAllText($tmp)
if ($check.Length -gt 0 -and [int]$check[0] -eq 0xFEFF) {
  Remove-Item $tmp -Force
  Write-Host "Refusing to install: the file written carries a BOM." -ForegroundColor Red
  exit 1
}
try { $null = $check | ConvertFrom-Json } catch {
  Remove-Item $tmp -Force
  Write-Host "Refusing to install: the file written is not valid JSON. auth.json is untouched." -ForegroundColor Red
  exit 1
}
Move-Item -LiteralPath $tmp -Destination $authPath -Force
Write-Host "`nauth.json updated and verified readable." -ForegroundColor Green

Write-Host "`n=== NOT DONE YET. The rotation is only half applied. ===" -ForegroundColor Yellow
Write-Host @"

1. Restart Latch AND Bureau. Bureau caches the token at boot, so until it restarts the OLD token still
   works against :4173 - the failure mode where you believe you have rotated and have not.

     (elevated, since these run as SYSTEM)
     Stop-ScheduledTask  -TaskName LLMServer-Bureau
     Stop-ScheduledTask  -TaskName LLMServer-Latch
     Start-ScheduledTask -TaskName LLMServer-Latch
     Start-ScheduledTask -TaskName LLMServer-Bureau

2. Re-enter the token in every browser that holds one. Bureau's UI keeps it in localStorage under
   'bureau_token' - it does NOT clear on a 401, it just prompts. Every device you opened Bureau from
   counts, including over the tailnet.

3. Update any MCP client configured against Bureau's /mcp, and anything using the token in a script or
   an environment variable (OPERATOR_TOKEN overrides the file entirely - if it is set anywhere, this
   rotation does nothing until that is changed too).

4. Confirm the old token is dead, not just that the new one works. Both halves matter:

     curl.exe -s -o NUL -w "%{http_code}\n" -H "Authorization: Bearer <OLD>" http://127.0.0.1:4173/api/state   # expect 401
     curl.exe -s -o NUL -w "%{http_code}\n" -H "Authorization: Bearer <NEW>" http://127.0.0.1:4173/api/state   # expect 200

   Note Bureau's failed-auth damper: repeated 401s from one client start returning 429. That is the guard
   working, not a rotation problem - wait out the window or test from a different address.

5. The backup at the path above still contains the OLD token. Delete it once the new one is confirmed
   working everywhere, or it is a live credential sitting in the data directory.
"@

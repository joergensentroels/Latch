param(
    [string]$Provider = "openai-compatible",

    [string]$BaseUrl = "https://api.openai.com/v1",

    [string]$Model = "",

    [string]$ApiKey = "",

    [switch]$PromptForApiKey,

    [switch]$PromptForApiKeyGui,

    [switch]$ApiKeyFromClipboard,

    [switch]$ShowApiKey,

    [switch]$ClearApiKey,

    [int]$TimeoutMs = 60000
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataDir = Join-Path $Root "data"
$ConfigPath = Join-Path $DataDir "llm-provider.json"

if (-not (Test-Path -LiteralPath $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir | Out-Null
}

$Existing = $null
if (Test-Path -LiteralPath $ConfigPath) {
    $Existing = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
}

if ($PromptForApiKey) {
    $SecureKey = Read-Host "External API key" -AsSecureString
    $Bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureKey)
    try {
        $ApiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Bstr)
    }
}

if ($PromptForApiKeyGui) {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $Form = New-Object System.Windows.Forms.Form
    $Form.Text = "Latch external API key"
    $Form.StartPosition = "CenterScreen"
    $Form.Width = 560
    $Form.Height = 190
    $Form.FormBorderStyle = "FixedDialog"
    $Form.MaximizeBox = $false
    $Form.MinimizeBox = $false

    $Label = New-Object System.Windows.Forms.Label
    $Label.Text = "Paste the external API key. It will be saved locally and not printed."
    $Label.Left = 16
    $Label.Top = 16
    $Label.Width = 510
    $Label.Height = 22
    $Form.Controls.Add($Label)

    $TextBox = New-Object System.Windows.Forms.TextBox
    $TextBox.Left = 16
    $TextBox.Top = 46
    $TextBox.Width = 510
    $TextBox.UseSystemPasswordChar = -not $ShowApiKey
    $Form.Controls.Add($TextBox)

    $Hint = New-Object System.Windows.Forms.Label
    $Hint.Text = "Length: 0"
    $Hint.Left = 16
    $Hint.Top = 78
    $Hint.Width = 200
    $Hint.Height = 20
    $Form.Controls.Add($Hint)

    $TextBox.Add_TextChanged({
        $Hint.Text = "Length: $($TextBox.Text.Trim().Length)"
    })

    $OkButton = New-Object System.Windows.Forms.Button
    $OkButton.Text = "Save"
    $OkButton.Left = 342
    $OkButton.Top = 108
    $OkButton.Width = 86
    $OkButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $Form.AcceptButton = $OkButton
    $Form.Controls.Add($OkButton)

    $CancelButton = New-Object System.Windows.Forms.Button
    $CancelButton.Text = "Cancel"
    $CancelButton.Left = 440
    $CancelButton.Top = 108
    $CancelButton.Width = 86
    $CancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $Form.CancelButton = $CancelButton
    $Form.Controls.Add($CancelButton)

    $TextBox.Select()
    $Result = $Form.ShowDialog()
    if ($Result -ne [System.Windows.Forms.DialogResult]::OK) {
        throw "API key entry was cancelled."
    }
    $ApiKey = $TextBox.Text.Trim()
    if (-not $ApiKey) {
        throw "No API key was entered."
    }
}

if ($ApiKeyFromClipboard) {
    $ApiKey = (Get-Clipboard -Raw).Trim()
    if (-not $ApiKey) {
        throw "Clipboard is empty. Copy the external API key first, then rerun with -ApiKeyFromClipboard."
    }
    Set-Clipboard -Value " "
}

if (-not $Model -and $Existing -and $Existing.model) {
    $Model = $Existing.model
}

if (-not $BaseUrl -and $Existing -and $Existing.baseUrl) {
    $BaseUrl = $Existing.baseUrl
}

if (-not $Provider -and $Existing -and $Existing.provider) {
    $Provider = $Existing.provider
}

$FinalApiKey = ""
if ($ClearApiKey) {
    $FinalApiKey = ""
} elseif ($ApiKey) {
    $FinalApiKey = $ApiKey.Trim()
} elseif ($Existing -and $Existing.apiKey) {
    $FinalApiKey = ([string]$Existing.apiKey).Trim()
}

$Config = [ordered]@{
    provider = $Provider
    baseUrl = $BaseUrl.TrimEnd("/")
    model = $Model
    apiKey = $FinalApiKey
    timeoutMs = $TimeoutMs
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
}

$Json = $Config | ConvertTo-Json
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($ConfigPath, $Json, $Utf8NoBom)

[PSCustomObject]@{
    ConfigPath = $ConfigPath
    Provider = $Config.provider
    BaseUrl = $Config.baseUrl
    Model = $Config.model
    HasApiKey = [bool]$Config.apiKey
    KeyLength = $Config.apiKey.Length
    KeyLooksPlausible = ($Config.apiKey.Length -gt 16)
    Ready = [bool]($Config.baseUrl -and $Config.model -and $Config.apiKey -and $Config.apiKey.Length -gt 16)
}

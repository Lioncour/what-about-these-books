param(
  [string]$ExePath = ""
)

$ErrorActionPreference = "Stop"

if (-not $ExePath) {
  $unpacked = Join-Path $PSScriptRoot "..\dist\win-unpacked\What About This Book.exe"
  $installed = Join-Path $env:LOCALAPPDATA "Programs\whataboutthisbook\What About This Book.exe"
  if (Test-Path $unpacked) { $ExePath = (Resolve-Path $unpacked).Path }
  elseif (Test-Path $installed) { $ExePath = (Resolve-Path $installed).Path }
  else {
    Write-Error "App not found. Run npm run dist first, or pass -ExePath to your installed .exe"
  }
}

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "What About This Book.lnk"
$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $ExePath
$shortcut.WorkingDirectory = Split-Path $ExePath -Parent
$shortcut.Description = "Chat with your book library using AWS Bedrock"
$icon = Join-Path (Split-Path $ExePath -Parent) "resources\standalone\public\icon.png"
if (Test-Path $icon) { $shortcut.IconLocation = $icon }
$shortcut.Save()
Write-Host "Desktop shortcut created: $shortcutPath"

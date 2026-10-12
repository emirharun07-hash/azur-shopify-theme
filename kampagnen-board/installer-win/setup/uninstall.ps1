# Kampagnen Board entfernen. Deine Boards bleiben in %APPDATA%\Kampagnen Board erhalten.
$ErrorActionPreference = 'SilentlyContinue'
$AppName = 'Kampagnen Board'
Get-Process -Name $AppName | Stop-Process -Force
Start-Sleep -Milliseconds 600
Remove-Item -Recurse -Force (Join-Path $env:LOCALAPPDATA "Programs\$AppName")
Remove-Item -Force (Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk")
Remove-Item -Force (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$AppName.lnk")
Write-Host ""
Write-Host "  Kampagnen Board wurde entfernt." -ForegroundColor Green
Write-Host "  Deine Boards liegen weiterhin in: $env:APPDATA\$AppName"
Write-Host "  (Diesen Ordner kannst du löschen, wenn du sie nicht mehr brauchst.)"
Write-Host ""

@echo off
title Kampagnen Board installieren
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\install.ps1"
if errorlevel 1 (
  echo.
  echo   Die Installation hat nicht geklappt. Die Meldung oben sagt warum.
  echo   Schick sie gern als Screenshot.
  pause
) else (
  timeout /t 6 >nul
)

@echo off
title Kampagnen Board entfernen
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\uninstall.ps1"
pause

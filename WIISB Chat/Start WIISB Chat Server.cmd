@echo off
title WIISB Chat Server
cd /d "%~dp0"
echo.
echo   WIISB Chat server  -  http://127.0.0.1:4310
echo   Voice/video media  -  ws://127.0.0.1:7880 (starts minimised)
echo   Leave this window open while you use WIISB Chat.
echo   Close it (or press Ctrl+C) to stop both.
echo.
if exist "%~dp0.data\tools\livekit\livekit-server.exe" (
  start "WIISB Chat Media" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-LocalMedia.ps1"
) else (
  echo   Voice is off: run scripts\Install-LocalMedia.ps1 once to install the media server.
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-LocalServer.ps1"
echo.
echo   The server has stopped. Stopping the media server too...
taskkill /im livekit-server.exe /f >nul 2>&1
pause

@echo off
rem Nidum Local launcher for Windows (EXPERIMENTAL: not verified on a real Windows machine).
rem Hands over to nidum-local.ps1 next to this file. Set NIDUM_DRY_RUN=1 to see every action without doing it.
rem nidum-local.ps1 exits 0 when done and 3 after its own failure screen; any other code means
rem PowerShell itself couldn't run the script, so this window pauses to keep the message readable.
setlocal
where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Nidum Local needs Windows PowerShell, which wasn't found on this computer.
  echo.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0nidum-local.ps1" %*
set "NIDUM_EXIT=%ERRORLEVEL%"
if not "%NIDUM_EXIT%"=="0" if not "%NIDUM_EXIT%"=="3" (
  echo.
  echo   Nidum Local couldn't run its PowerShell script ^(exit code %NIDUM_EXIT%^).
  echo   If your organisation blocks PowerShell scripts, ask your IT team for help.
  echo.
  pause
)
endlocal & exit /b %NIDUM_EXIT%

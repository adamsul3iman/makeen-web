@echo off
REM ═══════════════════════════════════════════════════════════════════
REM  MAKEEN Print Agent — Quick Installer
REM  Run as Administrator
REM ═══════════════════════════════════════════════════════════════════

echo.
echo  MAKEEN Print Agent — Installer
echo  ==============================
echo.

REM Check admin
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo  This installer requires Administrator privileges.
    echo  Right-click and select "Run as administrator".
    echo.
    pause
    exit /b 1
)

REM Check if .exe exists
if exist "release\MAKEEN-Printer.exe" (
    echo  [1/3] Running first-time setup...
    echo.
    "release\MAKEEN-Printer.exe"
    echo.
    echo  [2/3] Registering Windows Service...
    "release\MAKEEN-Printer.exe" --install
) else if exist "MAKEEN-Printer.exe" (
    echo  [1/3] Running first-time setup...
    echo.
    "MAKEEN-Printer.exe"
    echo.
    echo  [2/3] Registering Windows Service...
    "MAKEEN-Printer.exe" --install
) else (
    echo  ERROR: MAKEEN-Printer.exe not found.
    echo.
    echo  Build it first with: npm run build:exe
    echo  Then run this script from the print-agent/ folder.
    echo.
    pause
    exit /b 1
)

echo.
echo  [3/3] Done!
echo.
echo  The print agent is now running as a Windows Service.
echo  It will start automatically on boot.
echo.
echo  Health check:  http://localhost:9100/health
echo  Service name:  MakeenPrinter
echo  Manage:        services.msc
echo.
pause

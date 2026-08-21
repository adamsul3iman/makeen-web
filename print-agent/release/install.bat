@echo off
echo.
echo  ══════════════════════════════════════════════
echo   MAKEEN Print Agent — Installer
echo  ══════════════════════════════════════════════
echo.

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo  ERROR: Run this as Administrator.
    echo  Right-click and select "Run as administrator".
    pause
    exit /b 1
)

echo  [1/2] Running first-time setup...
echo.
MAKEEN-Printer.exe
echo.
echo  [2/2] Registering Windows Service...
echo.
MAKEEN-Printer.exe --install
echo.
echo  ══════════════════════════════════════════════
echo   Done! Print agent starts on boot.
echo   Health: http://localhost:9100/health
echo  ══════════════════════════════════════════════
echo.
pause

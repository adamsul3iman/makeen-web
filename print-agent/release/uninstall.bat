@echo off
echo.
echo  MAKEEN Print Agent — Uninstaller
echo.
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo  Run as Administrator.
    pause
    exit /b 1
)
MAKEEN-Printer.exe --uninstall
pause

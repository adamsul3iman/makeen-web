@echo off
REM ═══════════════════════════════════════════════════════════════════
REM  MAKEEN Print Agent — Uninstaller
REM  Run as Administrator
REM ═══════════════════════════════════════════════════════════════════

echo.
echo  MAKEEN Print Agent — Uninstaller
echo  ================================
echo.

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo  This requires Administrator privileges.
    pause
    exit /b 1
)

if exist "release\MAKEEN-Printer.exe" (
    "release\MAKEEN-Printer.exe" --uninstall
) else if exist "MAKEEN-Printer.exe" (
    "MAKEEN-Printer.exe" --uninstall
) else (
    echo  MAKEEN-Printer.exe not found — trying sc.exe directly...
    sc stop MakeenPrinter >nul 2>&1
    sc delete MakeenPrinter >nul 2>&1
    echo  Done.
)

echo.
pause

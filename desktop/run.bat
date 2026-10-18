@echo off
setlocal EnableDelayedExpansion
title Currency Carry Strategy Manager
echo ========================================
echo   Currency Carry Strategy Manager
echo ========================================
echo.

echo Checking Python...
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python not found.
    echo Please install Python 3.10+ from https://www.python.org
    echo Make sure to check "Add Python to PATH" during installation.
    pause
    exit /b 1
)
python --version
echo.

echo Checking dependencies...
python -c "import PyQt6, matplotlib, pandas, numpy" >nul 2>&1
if errorlevel 1 (
    echo Installing base libraries...
    echo This may take a minute.
    echo.
    python -m pip install --upgrade pip
    python -m pip install -r requirements.txt
    if errorlevel 1 (
        echo.
        echo ERROR: Failed to install base dependencies.
        pause
        exit /b 1
    )
    echo Base libraries installed.
) else (
    echo Base libraries are already installed.
)
echo.

echo API Т-Банка идёт напрямую, отдельный SDK не нужен.
echo.

echo Starting application...
echo.
python main.py
set EXITCODE=!errorlevel!

echo.
echo ========================================
echo Application finished.
echo Exit code: !EXITCODE!
echo ========================================
pause
exit /b !EXITCODE!

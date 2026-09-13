@echo off
REM ============================================
REM Flask Invoice Parser - Windows Start Script
REM ============================================

setlocal enabledelayedexpansion
cd /d "%~dp0"

color 0A
echo.
echo ========================================
echo Flask Invoice Parser Starting...
echo ========================================
echo.

REM Check if .env exists
if not exist .\.env (
    color 0C
    echo ERROR: .env file not found!
    echo Please run setup.bat first
    pause
    exit /b 1
)

REM Check if virtual environment exists
if not exist .\.venv\Scripts\activate.bat (
    color 0C
    echo ERROR: Virtual environment not found!
    echo Please run setup.bat first
    pause
    exit /b 1
)

REM Activate virtual environment
call .\.venv\Scripts\activate.bat

REM Display current configuration
echo.
echo Current Configuration:
echo ---------------------
for /f "tokens=*" %%i in (.\.env) do (
    if not "%%i"=="" (
        if not "%%i:~0,1%%"=="REM" (
            echo %%i
        )
    )
)
echo.

REM Check backend connectivity
echo Checking backend connectivity...
python -c "import requests; r = requests.get('http://localhost:4000/health', timeout=2); print('[OK] Backend is available' if r.status_code == 200 else '[WARNING] Backend may not be running')" 2>nul || echo [WARNING] Backend appears to be offline

REM Start the Flask app
echo.
echo Starting Flask Invoice Parser (listening on http://0.0.0.0:5100)...
echo Press Ctrl+C to stop
echo.
python run.py

pause
exit /b %ERRORLEVEL%

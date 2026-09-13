@echo off
REM ============================================
REM Flask Invoice Parser - Windows Setup Script
REM ============================================
REM This script prepares the Flask backend for local deployment on Windows

setlocal enabledelayedexpansion
cd /d "%~dp0"

color 0A
echo.
echo ========================================
echo Flask Invoice Parser Setup for Windows
echo ========================================
echo.

REM Check Python installation
python --version >nul 2>&1
if errorlevel 1 (
    color 0C
    echo ERROR: Python is not installed or not in PATH
    echo.
    echo Please install Python 3.8+ from https://www.python.org/
    echo Make sure to check "Add Python to PATH" during installation
    pause
    exit /b 1
)

echo [OK] Python found: 
python --version
echo.

REM Create virtual environment
echo Creating virtual environment...
if exist .\.venv (
    echo Virtual environment already exists. Skipping creation.
) else (
    python -m venv .venv
    if errorlevel 1 (
        color 0C
        echo ERROR: Failed to create virtual environment
        pause
        exit /b 1
    )
    echo [OK] Virtual environment created
)
echo.

REM Activate virtual environment
echo Activating virtual environment...
call .\.venv\Scripts\activate.bat
if errorlevel 1 (
    color 0C
    echo ERROR: Failed to activate virtual environment
    pause
    exit /b 1
)
echo [OK] Virtual environment activated
echo.

REM Upgrade pip
echo Upgrading pip...
python -m pip install --upgrade pip --quiet
if errorlevel 1 (
    echo WARNING: Failed to upgrade pip, continuing anyway...
)

REM Install dependencies
echo Installing required packages...
pip install -r requirements.txt
if errorlevel 1 (
    color 0C
    echo ERROR: Failed to install dependencies
    pause
    exit /b 1
)
echo [OK] All packages installed successfully
echo.

REM Check/Create .env file
echo Configuring environment...
if not exist .\.env (
    echo Creating .env file from template...
    if exist .\.env.example (
        copy .\.env.example .\.env >nul
    ) else (
        (
            echo FLASK_PORT=5100
            echo LOG_LEVEL=INFO
            echo BACKEND_API_URL=http://localhost:4000/api
            echo INGEST_API_KEY=
            echo WATCH_FOLDERS=
            echo BACKFILL_ON_START=true
            echo SYNC_REQUEST_TIMEOUT_SEC=120
            echo SYNC_RETRY_DELAY_SEC=5
            echo MAX_RETRY_ATTEMPTS=3
            echo OPENAI_API_KEY=
            echo OPENAI_MODEL=gpt-4-vision-preview
        ) > .\.env
    )
    color 0E
    echo [ATTENTION] .env file created - YOU MUST CONFIGURE IT!
    color 0A
    echo.
    echo Please edit .\.env and set:
    echo   - WATCH_FOLDERS: Path to your invoice files (e.g., C:\Invoices)
    echo   - BACKEND_API_URL: Your backend URL (default: http://localhost:4000/api^)
    echo   - OPENAI_API_KEY: (optional^) Your OpenAI key for AI enhancements
    echo.
) else (
    echo [OK] .env file already exists
)
echo.

REM Create watch folder if needed
echo.
echo ========================================
echo Setup Complete!
echo ========================================
echo.
echo Next steps:
echo 1. Edit .\.env and set your WATCH_FOLDERS path
echo 2. Run: start.bat
echo.
echo Example .env configuration:
echo   WATCH_FOLDERS=C:\Invoices;C:\Downloads
echo   BACKEND_API_URL=http://localhost:4000/api
echo.
pause
exit /b 0

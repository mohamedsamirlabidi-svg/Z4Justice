@echo off
REM ============================================
REM Flask Parser - Configuration & Test Script
REM ============================================

setlocal enabledelayedexpansion
cd /d "%~dp0"

color 0A
echo.
echo ========================================
echo Flask Parser Configuration Tool
echo ========================================
echo.

REM Menu
:menu
echo.
echo What would you like to do?
echo [1] Test backend connectivity
echo [2] Show current configuration
echo [3] Edit .env file
echo [4] Create test watch folder
echo [5] View recent logs
echo [6] Reset configuration
echo [0] Exit
echo.

set /p choice="Enter your choice [0-6]: "

if "%choice%"=="1" goto test_backend
if "%choice%"=="2" goto show_config
if "%choice%"=="3" goto edit_config
if "%choice%"=="4" goto create_folder
if "%choice%"=="5" goto show_logs
if "%choice%"=="6" goto reset_config
if "%choice%"=="0" exit /b 0

echo Invalid choice. Please try again.
goto menu

:test_backend
echo.
echo Testing backend connectivity...
python -c "
import requests
import sys
try:
    url = 'http://localhost:4000/health'
    r = requests.get(url, timeout=5)
    if r.status_code == 200:
        print('✅ Backend is ONLINE and responding')
        print('   URL: ' + url)
        print('   Status: ' + str(r.status_code))
    else:
        print('⚠️  Backend responded but with status: ' + str(r.status_code))
except Exception as e:
    print('❌ Backend is OFFLINE or unreachable')
    print('   Error: ' + str(e))
    print('   Make sure backend is running on http://localhost:4000')
" 2>nul || echo ❌ Unable to test connection
echo.
pause
goto menu

:show_config
echo.
echo Current Configuration:
echo =====================
type .\.env
echo.
pause
goto menu

:edit_config
echo.
echo Opening .env in notepad...
notepad .\.env
echo.
pause
goto menu

:create_folder
echo.
set /p folder="Enter watch folder path (e.g., C:\Invoices): "
if not exist "!folder!" (
    mkdir "!folder!"
    echo ✅ Folder created: !folder!
) else (
    echo ⚠️  Folder already exists: !folder!
)
echo.
pause
goto menu

:show_logs
echo.
echo Recent logs:
echo ============
if exist failed_files.log (
    echo.
    echo Failed files log:
    type failed_files.log | tail -10
) else (
    echo No logs found yet.
)
echo.
pause
goto menu

:reset_config
echo.
echo WARNING: This will reset the .env file to defaults
set /p confirm="Are you sure? (y/n): "
if /i "%confirm%"=="y" (
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
    echo ✅ Configuration reset to defaults
    echo Please edit .env and configure WATCH_FOLDERS
) else (
    echo ✅ Reset cancelled
)
echo.
pause
goto menu

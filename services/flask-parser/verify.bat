@echo off
REM ============================================
REM Flask Parser - Verification Test Script
REM ============================================

setlocal enabledelayedexpansion
cd /d "%~dp0"

color 0A
echo.
echo ========================================
echo Flask Parser Verification Test
echo ========================================
echo.

REM Check Python
echo Checking Python installation...
python --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Python not found. Please install Python 3.8+
    pause
    exit /b 1
)
echo ✅ Python found

REM Check venv
echo.
echo Checking virtual environment...
if not exist "venv" (
    echo ⚠️  Virtual environment not found
    echo Run setup.bat first to create the environment
    pause
    exit /b 1
)
echo ✅ Virtual environment found

REM Activate venv
echo.
echo Activating virtual environment...
call venv\Scripts\activate.bat

REM Check Flask
echo.
echo Checking Flask installation...
python -c "import flask" 2>nul
if errorlevel 1 (
    echo ❌ Flask not installed
    echo Run setup.bat to install dependencies
    pause
    exit /b 1
)
echo ✅ Flask found

REM Check dependencies
echo.
echo Checking required packages...
python -c "
import sys
packages = ['openpyxl', 'pandas', 'pdfplumber', 'requests', 'watchdog', 'python-dotenv']
missing = []
for pkg in packages:
    try:
        __import__(pkg)
    except ImportError:
        missing.append(pkg)

if missing:
    print('❌ Missing packages: ' + ', '.join(missing))
    print('   Run: pip install ' + ' '.join(missing))
    sys.exit(1)
else:
    print('✅ All required packages installed')
"
if errorlevel 1 (
    pause
    exit /b 1
)

REM Check OpenAI (optional)
echo.
echo Checking OpenAI (optional)...
python -c "
try:
    from openai import OpenAI
    print('✅ OpenAI package available')
except ImportError:
    print('⚠️  OpenAI not installed (AI features disabled)')
" 2>nul || echo ⚠️  OpenAI not available

REM Test Flask app import
echo.
echo Testing Flask app import...
python -c "
import sys
sys.path.insert(0, 'app')
try:
    from config import Config
    print('✅ Flask app configuration loaded')
    print(f'   Port: {Config.FLASK_PORT}')
    print(f'   Backend API: {Config.BACKEND_API_URL}')
    print(f'   Watch Folders: {Config.WATCH_FOLDERS}')
except Exception as e:
    print(f'❌ Error loading config: {str(e)}')
" || (
    echo ❌ Failed to load Flask configuration
    pause
    exit /b 1
)

REM Test file watcher
echo.
echo Testing file watcher...
python -c "
try:
    from watchdog.observers import Observer
    print('✅ Watchdog file watcher available')
except ImportError:
    print('❌ Watchdog not installed')
" || echo ❌ File watcher check failed

REM Test parsers
echo.
echo Testing invoice parsers...
python -c "
import sys
sys.path.insert(0, 'app')
try:
    from parsers.excel_parser import ExcelParser
    from parsers.pdf_parser import PDFParser
    from parsers.csv_parser import CSVParser
    print('✅ All parser modules loaded successfully')
    print('   - ExcelParser: OK')
    print('   - PDFParser: OK')
    print('   - CSVParser: OK')
except Exception as e:
    print(f'❌ Parser error: {str(e)}')
" || echo ❌ Parser check failed

REM Check .env
echo.
echo Checking environment configuration...
if not exist ".env" (
    echo ⚠️  .env file not found
    echo Run setup.bat to create the environment file
) else (
    echo ✅ .env file exists
    python -c "
from dotenv import load_dotenv
import os
load_dotenv()
watch_folders = os.getenv('WATCH_FOLDERS', '')
if watch_folders:
    print(f'✅ WATCH_FOLDERS configured: {watch_folders}')
else:
    print('⚠️  WATCH_FOLDERS not configured')
    print('   Edit .env and set WATCH_FOLDERS to your invoice directory')
" 2>nul
)

REM Summary
echo.
echo ========================================
echo ✅ Verification Complete
echo ========================================
echo.
echo Next steps:
echo 1. Ensure backend is running (npm run dev from root)
echo 2. Configure WATCH_FOLDERS in .env
echo 3. Place test invoice files in watch folder
echo 4. Run start.bat to launch the Flask parser
echo 5. Check the logs for successful parsing
echo.
pause

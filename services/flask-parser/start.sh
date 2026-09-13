#!/bin/bash
# ============================================
# Flask Invoice Parser - Linux/Mac Start Script
# ============================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "========================================"
echo "Flask Invoice Parser Starting..."
echo "========================================"
echo ""

# Check if .env exists
if [ ! -f "./.env" ]; then
    echo "❌ ERROR: .env file not found!"
    echo "Please run ./setup.sh first"
    exit 1
fi

# Check if virtual environment exists
if [ ! -f "./.venv/bin/activate" ]; then
    echo "❌ ERROR: Virtual environment not found!"
    echo "Please run ./setup.sh first"
    exit 1
fi

# Activate virtual environment
source ./.venv/bin/activate

# Display configuration
echo "Current Configuration:"
echo "---------------------"
grep -v "^#" ./.env | grep -v "^$"
echo ""

# Check backend connectivity
echo "Checking backend connectivity..."
python3 -c "
try:
    import requests
    r = requests.get('http://localhost:4000/health', timeout=2)
    print('✅ Backend is available' if r.status_code == 200 else '⚠️  Backend response: ' + str(r.status_code))
except Exception as e:
    print('⚠️  Backend appears to be offline: ' + str(e))
" 2>/dev/null || echo "⚠️  Unable to check backend"

echo ""
echo "Starting Flask Invoice Parser..."
echo "Listening on http://0.0.0.0:5100"
echo "Press Ctrl+C to stop"
echo ""

python3 run.py

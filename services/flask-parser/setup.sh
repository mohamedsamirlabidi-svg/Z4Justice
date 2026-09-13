#!/bin/bash
# ============================================
# Flask Invoice Parser - Linux/Mac Setup Script
# ============================================
# This script prepares the Flask backend for local deployment

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "========================================"
echo "Flask Invoice Parser Setup (Linux/Mac)"
echo "========================================"
echo ""

# Check Python installation
if ! command -v python3 &> /dev/null; then
    echo "❌ ERROR: Python 3 is not installed"
    echo ""
    echo "Please install Python 3.8+ from https://www.python.org/"
    echo ""
    echo "On macOS: brew install python3"
    echo "On Ubuntu/Debian: sudo apt-get install python3 python3-pip python3-venv"
    exit 1
fi

echo "✅ Python found:"
python3 --version
echo ""

# Create virtual environment
echo "Creating virtual environment..."
if [ -d ".venv" ]; then
    echo "Virtual environment already exists. Skipping creation."
else
    python3 -m venv .venv
    [ $? -eq 0 ] && echo "✅ Virtual environment created" || {
        echo "❌ ERROR: Failed to create virtual environment"
        exit 1
    }
fi
echo ""

# Activate virtual environment
echo "Activating virtual environment..."
source ./.venv/bin/activate
[ $? -eq 0 ] && echo "✅ Virtual environment activated" || {
    echo "❌ ERROR: Failed to activate virtual environment"
    exit 1
}
echo ""

# Upgrade pip
echo "Upgrading pip..."
pip install --upgrade pip --quiet 2>/dev/null || echo "⚠️  Warning: pip upgrade had issues, continuing..."

# Install dependencies
echo "Installing required packages..."
pip install -r requirements.txt
[ $? -eq 0 ] && echo "✅ All packages installed successfully" || {
    echo "❌ ERROR: Failed to install dependencies"
    exit 1
}
echo ""

# Check/Create .env file
echo "Configuring environment..."
if [ ! -f "./.env" ]; then
    echo "Creating .env file..."
    if [ -f "./.env.example" ]; then
        cp ./.env.example ./.env
    else
        cat > ./.env << 'EOF'
FLASK_PORT=5100
LOG_LEVEL=INFO
BACKEND_API_URL=http://localhost:4000/api
INGEST_API_KEY=
WATCH_FOLDERS=
BACKFILL_ON_START=true
SYNC_REQUEST_TIMEOUT_SEC=120
SYNC_RETRY_DELAY_SEC=5
MAX_RETRY_ATTEMPTS=3
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4-vision-preview
EOF
    fi
    echo ""
    echo "⚠️  ATTENTION: .env file created - YOU MUST CONFIGURE IT!"
    echo ""
    echo "Please edit ./.env and set:"
    echo "  - WATCH_FOLDERS: Path to your invoice files (e.g., /home/user/invoices)"
    echo "  - BACKEND_API_URL: Your backend URL (default: http://localhost:4000/api)"
    echo "  - OPENAI_API_KEY: (optional) Your OpenAI key for AI enhancements"
    echo ""
else
    echo "✅ .env file already exists"
fi
echo ""

echo "========================================"
echo "Setup Complete!"
echo "========================================"
echo ""
echo "Next steps:"
echo "1. Edit ./.env and set your WATCH_FOLDERS path"
echo "2. Run: ./start.sh"
echo ""
echo "Example .env configuration:"
echo "  WATCH_FOLDERS=/home/user/invoices:/mnt/shared/factures"
echo "  BACKEND_API_URL=http://localhost:4000/api"
echo ""

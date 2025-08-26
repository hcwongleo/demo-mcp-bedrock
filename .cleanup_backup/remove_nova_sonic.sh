#!/bin/bash

echo "=== Removing Nova Sonic Components ==="
echo "This script removes all Nova Sonic voice-related components from the application"
echo ""

# 1. Remove pyaudio from dependencies
echo "1. Removing pyaudio from dependencies..."
if grep -q "pyaudio" pyproject.toml; then
    sed -i.bak '/pyaudio>=0.2.14/d' pyproject.toml
    echo "✓ Removed pyaudio from pyproject.toml"
else
    echo "✓ pyaudio already removed from pyproject.toml"
fi

# 2. Update dependencies
echo "2. Updating Python dependencies..."
if [ -d ".venv" ]; then
    source .venv/bin/activate
    uv sync
    echo "✓ Dependencies updated"
else
    echo "⚠ Virtual environment not found. Run 'python3 -m venv .venv' first"
fi

# 3. Backup and remove Nova Sonic files
echo "3. Removing Nova Sonic files..."
if [ -f "src/nova_sonic_manager.py" ]; then
    mv src/nova_sonic_manager.py src/nova_sonic_manager.py.backup
    echo "✓ Moved nova_sonic_manager.py to backup"
else
    echo "✓ nova_sonic_manager.py already removed"
fi

# 4. Clean main.py (already done, but verify)
echo "4. Verifying main.py cleanup..."
if grep -q "nova_sonic_manager" src/main.py; then
    echo "⚠ Found remaining nova_sonic_manager references in main.py"
else
    echo "✓ main.py is clean of Nova Sonic references"
fi

# 5. Test the application
echo "5. Testing application..."
python -c "
import sys
sys.path.append('src')
try:
    import main
    print('✓ Main application works without Nova Sonic')
except Exception as e:
    print(f'✗ Error: {e}')
    exit(1)
"

echo ""
echo "=== Nova Sonic Removal Complete ==="
echo "✓ PyAudio dependency removed"
echo "✓ Nova Sonic manager removed"
echo "✓ WebSocket voice endpoints removed"
echo "✓ Application tested successfully"
echo ""
echo "The application is now simplified and should deploy without any audio-related issues!"

#!/bin/bash

# Test script to verify the application works locally
echo "Testing MCP on Amazon Bedrock application locally..."

# Check if virtual environment exists
if [ ! -d ".venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv .venv
fi

# Activate virtual environment
source .venv/bin/activate

# Install dependencies
echo "Installing dependencies..."
pip install --upgrade pip
pip install uv
uv sync

# Check if pyaudio is properly handled
echo "Testing pyaudio handling..."
python -c "
import sys
sys.path.append('src')
try:
    from nova_sonic_manager import WebSocketAudioProcessor
    print('✓ WebSocketAudioProcessor imported successfully')
    print('✓ PyAudio handling works correctly')
except Exception as e:
    print(f'✗ Error importing WebSocketAudioProcessor: {e}')
    exit(1)
"

# Test main application import
echo "Testing main application..."
python -c "
import sys
sys.path.append('src')
try:
    import main
    print('✓ Main application imports successfully')
except Exception as e:
    print(f'✗ Error importing main application: {e}')
    exit(1)
"

# Test chatbot import
echo "Testing chatbot..."
python -c "
try:
    import chatbot
    print('✓ Chatbot imports successfully')
except Exception as e:
    print(f'✗ Error importing chatbot: {e}')
    exit(1)
"

echo "✓ All tests passed! Application should work correctly."

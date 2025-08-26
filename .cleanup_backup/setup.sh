#!/bin/bash

# MCP on Amazon Bedrock Setup Script
# This script sets up the environment and dependencies for the MCP application

set -e  # Exit on any error

echo "=== MCP on Amazon Bedrock Setup ==="

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    echo "Warning: Running as root. Some operations will be performed as ubuntu user."
    USER_HOME="/home/ubuntu"
    SETUP_USER="ubuntu"
else
    USER_HOME="$HOME"
    SETUP_USER="$(whoami)"
fi

PROJECT_DIR="$USER_HOME/demo_mcp_on_amazon_bedrock"

# Function to run commands as the appropriate user
run_as_user() {
    if [ "$EUID" -eq 0 ] && [ "$SETUP_USER" = "ubuntu" ]; then
        su - ubuntu -c "cd $PROJECT_DIR && $1"
    else
        bash -c "cd $PROJECT_DIR && $1"
    fi
}

echo "1. Installing system dependencies..."

# Update package list
apt-get update

# Install Python 3.12 and development tools
apt-get install -y software-properties-common
add-apt-repository -y ppa:deadsnakes/ppa
apt-get update
apt-get install -y python3.12 python3.12-venv python3.12-dev git build-essential

# Install audio dependencies (optional, for voice features)
apt-get install -y portaudio19-dev || echo "Warning: Audio dependencies not available"

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

echo "2. Installing UV package manager..."
if [ "$EUID" -eq 0 ]; then
    su - ubuntu -c "curl -LsSf https://astral.sh/uv/install.sh | sh"
    echo 'export PATH="/home/ubuntu/.local/bin:$PATH"' >> /home/ubuntu/.bashrc
else
    curl -LsSf https://astral.sh/uv/install.sh | sh
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
fi

echo "3. Setting up project directory..."
mkdir -p "$PROJECT_DIR"
if [ "$EUID" -eq 0 ]; then
    chown ubuntu:ubuntu "$PROJECT_DIR"
fi

cd "$PROJECT_DIR"

echo "4. Installing Python dependencies..."
run_as_user "python3.12 -m venv .venv"
run_as_user "source .venv/bin/activate && source ~/.bashrc && uv pip install ."

echo "5. Creating directories..."
run_as_user "mkdir -p logs tmp"

echo "6. Setting up environment configuration..."
if [ ! -f ".env" ]; then
    if [ -f "env_dev" ]; then
        run_as_user "cp env_dev .env"
        echo "Created .env from env_dev template"
    else
        echo "Warning: No env_dev template found. Please create .env manually."
    fi
fi

# Ensure MCP_BASE_URL is set in .env
run_as_user "
if ! grep -q 'MCP_BASE_URL' .env; then
    echo 'MCP_BASE_URL=http://127.0.0.1:7002' >> .env
    echo 'Added MCP_BASE_URL to .env'
fi
"

echo "7. Making scripts executable..."
run_as_user "chmod +x *.sh"

echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "1. Edit .env file with your AWS credentials and configuration"
echo "2. Run './start_all.sh' to start the MCP backend service"
echo "3. Run './start_chatbot.sh' to start the Streamlit UI"
echo ""
echo "Or run both services with: './start_all.sh && ./start_chatbot.sh'"
echo ""
echo "Access the application at: http://localhost:8502"

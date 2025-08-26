#!/bin/bash

# Activate virtual environment
source .venv/bin/activate

# Export environment variables
export $(grep -v "^#" .env | xargs)

# Start MCP backend in background
python src/main.py --mcp-conf conf/config.json --user-conf conf/user_mcp_config.json --host 127.0.0.1 --port 7002 &

# Wait a bit for MCP to start
sleep 5

# Start Streamlit frontend
streamlit run chatbot.py --server.port 8502 --server.address 0.0.0.0 --server.headless true

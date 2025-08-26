#!/bin/bash

# Load environment variables
export $(grep -v '^#' .env | xargs)
source .venv/bin/activate

# Create logs directory if it doesn't exist
mkdir -p ${LOG_DIR}

# Set MCP_BASE_URL if not already set
if [ -z "$MCP_BASE_URL" ]; then
    if [ "${USE_HTTPS}" = "1" ] || [ "${USE_HTTPS}" = "true" ]; then
        PROTOCOL="https"
    else
        PROTOCOL="http"
    fi
    export MCP_BASE_URL=${PROTOCOL}://${MCP_SERVICE_HOST}:${MCP_SERVICE_PORT}
    echo "Set MCP_BASE_URL to: ${MCP_BASE_URL}"
fi

port=${CHATBOT_SERVICE_PORT}
LOG_FILE="${LOG_DIR}/start_chatbot_$(date +%Y%m%d_%H%M%S).log"

echo "Starting Chatbot service..."
echo "MCP_BASE_URL: ${MCP_BASE_URL}"
echo "Chatbot service port: ${port}"

# Kill any existing streamlit processes on this port
lsof -t -i:$port -c streamlit| xargs kill -9 2> /dev/null

# Start Streamlit with proper configuration
nohup streamlit run chatbot.py \
    --server.port ${port} \
    --server.address 0.0.0.0 \
    --server.headless true \
    --server.runOnSave false \
    --browser.gatherUsageStats false \
    > ${LOG_FILE} 2>&1 &

echo "Chatbot service started. Check logs in ${LOG_FILE}"
echo "Access the application at: http://localhost:${port}"

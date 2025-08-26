#!/bin/bash
export $(grep -v '^#' .env | xargs)
export PYTHONPATH=./src:$PYTHONPATH
source .venv/bin/activate

# Create necessary directories
mkdir -p ./tmp
mkdir -p ${LOG_DIR}

LOG_FILE1="${LOG_DIR}/start_mcp_$(date +%Y%m%d_%H%M%S).log"
LOG_FILE2="${LOG_DIR}/start_chatbot_$(date +%Y%m%d_%H%M%S).log"

# Set protocol
if [ "${USE_HTTPS}" = "1" ] || [ "${USE_HTTPS}" = "true" ]; then
    PROTOCOL="https"
    HTTPS_ARGS="--https"
else
    PROTOCOL="http"
    HTTPS_ARGS=""
fi

export MCP_BASE_URL=${PROTOCOL}://${MCP_SERVICE_HOST}:${MCP_SERVICE_PORT}
echo "MCP_BASE_URL: ${MCP_BASE_URL}"
echo "Starting services..."

# Start MCP service
echo "Starting MCP service with ${PROTOCOL}..."
nohup python src/main.py --mcp-conf conf/config.json --user-conf conf/user_mcp_config.json --host ${MCP_SERVICE_HOST} --port ${MCP_SERVICE_PORT} ${HTTPS_ARGS} > ${LOG_FILE1} 2>&1 &

# Start Chatbot service
echo "Starting Chatbot service..."
nohup streamlit run chatbot.py --server.port ${CHATBOT_SERVICE_PORT} --server.address 0.0.0.0 --server.headless true --server.runOnSave false --browser.gatherUsageStats false > ${LOG_FILE2} 2>&1 &

echo "Services started. Check logs in ${LOG_DIR}"

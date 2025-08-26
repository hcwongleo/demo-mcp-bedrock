FROM python:3.12-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

# Install uv
RUN pip install uv

# Set working directory
WORKDIR /app

# Clone the repository
RUN git clone https://github.com/hcwongleo/demo-mcp-bedrock.git .

# Install Python dependencies
RUN uv sync --no-dev

# Create .env file
RUN echo "AWS_REGION=us-east-1\nLOG_DIR=./logs\nCHATBOT_SERVICE_PORT=8502\nMCP_SERVICE_HOST=127.0.0.1\nMCP_SERVICE_PORT=7002\nAPI_KEY=mcp-demo-key" > .env

# Create logs directory
RUN mkdir -p logs tmp

# Expose port
EXPOSE 8502

# Start script
COPY start-docker.sh /start.sh
RUN chmod +x /start.sh

CMD ["/start.sh"]

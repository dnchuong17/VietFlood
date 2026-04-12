#!/bin/sh

################################################################################
# VietFlood Unified Docker Entry Point
# Starts all 3 services in one container
################################################################################

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

require_env() {
  var_name="$1"
  eval "var_value=\${$var_name}"

  if [ -z "$var_value" ]; then
    echo -e "${BLUE}Missing required environment variable:${NC} $var_name"
    exit 1
  fi
}

# Runtime defaults for non-secret settings.
export API_GATEWAY_PORT="${API_GATEWAY_PORT:-8081}"
export REDIS_HOST="${REDIS_HOST:-redis}"
export REDIS_PORT="${REDIS_PORT:-6379}"
export REDIS_DB="${REDIS_DB:-0}"
export RABBITMQ_DEFAULT_USER="${RABBITMQ_DEFAULT_USER:-admin}"
export RABBITMQ_DEFAULT_PASS="${RABBITMQ_DEFAULT_PASS:-admin}"
export RABBITMQ_URL="${RABBITMQ_URL:-amqp://${RABBITMQ_DEFAULT_USER}:${RABBITMQ_DEFAULT_PASS}@rabbitmq:5672}"

require_env DATABASE_URL
require_env JWT_SECRET
require_env REFRESH_SECRET

case "$REDIS_PORT" in
  ''|*[!0-9]*)
    echo -e "${BLUE}Invalid REDIS_PORT:${NC} $REDIS_PORT"
    exit 1
    ;;
esac

case "$REDIS_DB" in
  ''|*[!0-9]*)
    echo -e "${BLUE}Invalid REDIS_DB:${NC} $REDIS_DB"
    exit 1
    ;;
esac

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  VietFlood Unified Container Started  ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

# Start API Gateway in background
echo -e "${GREEN}► Starting API Gateway (port 8081)...${NC}"
node dist/api-gateway/main.js &
API_GATEWAY_PID=$!

# Give API Gateway time to start
sleep 2

# Start Auth Service in background
echo -e "${GREEN}► Starting Auth Service (RabbitMQ consumer)...${NC}"
node dist/auth-service/main.js &
AUTH_SERVICE_PID=$!

# Start Reports Service in background
echo -e "${GREEN}► Starting Reports Service (RabbitMQ consumer)...${NC}"
node dist/reports-service/main.js &
REPORTS_SERVICE_PID=$!

# Ensure all processes survived initial boot before declaring success.
sleep 3

for pid in "$API_GATEWAY_PID" "$AUTH_SERVICE_PID" "$REPORTS_SERVICE_PID"; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo -e "${BLUE}Service startup failed. Stopping remaining processes.${NC}"
    kill "$API_GATEWAY_PID" "$AUTH_SERVICE_PID" "$REPORTS_SERVICE_PID" 2>/dev/null || true
    wait || true
    exit 1
  fi
done

echo ""
echo -e "${GREEN}✓ All services started${NC}"
echo ""
echo -e "${BLUE}════════════════════════════════════════${NC}"
echo -e "${BLUE}API Gateway:     http://localhost:${API_GATEWAY_PORT}${NC}"
echo -e "${BLUE}Auth Service:    RabbitMQ queue auth_queue${NC}"
echo -e "${BLUE}Reports Service: RabbitMQ queue reports_queue${NC}"
echo -e "${BLUE}════════════════════════════════════════${NC}"
echo ""

# Handle termination signals
trap "echo 'Stopping services...'; kill $API_GATEWAY_PID $AUTH_SERVICE_PID $REPORTS_SERVICE_PID 2>/dev/null; exit 0" SIGTERM SIGINT

# Wait for all processes
wait

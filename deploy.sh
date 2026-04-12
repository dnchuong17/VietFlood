#!/bin/bash

# VietFlood Docker Deployment Helper Script
# This script provides easy commands for managing Docker deployment

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
ENV_FILE=".env"
DOCKER_COMPOSE_CMD="docker-compose"

# Functions
print_header() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

check_env_file() {
    if [ ! -f "$ENV_FILE" ]; then
        print_error "Environment file $ENV_FILE not found!"
        return 1
    fi
    return 0
}

check_docker() {
    if ! command -v docker &> /dev/null; then
        print_error "Docker is not installed"
        exit 1
    fi

    if ! command -v docker-compose &> /dev/null; then
        print_warning "Using 'docker compose' instead of 'docker-compose'"
        DOCKER_COMPOSE_CMD="docker compose"
    fi

    print_success "Docker is available"
}

cmd_build() {
    print_header "Building Docker Images"
    $DOCKER_COMPOSE_CMD build
    print_success "Build completed"
}

cmd_start() {
    if ! check_env_file; then
        return 1
    fi

    print_header "Starting Services"
    $DOCKER_COMPOSE_CMD up -d
    print_success "Services started"
    sleep 3
    cmd_status
}

cmd_stop() {
    print_header "Stopping Services"
    $DOCKER_COMPOSE_CMD stop
    print_success "Services stopped"
}

cmd_restart() {
    print_header "Restarting Services"
    $DOCKER_COMPOSE_CMD restart
    print_success "Services restarted"
}

cmd_status() {
    print_header "Service Status"
    $DOCKER_COMPOSE_CMD ps
}

cmd_logs() {
    local service=$1
    print_header "Service Logs"
    if [ -z "$service" ]; then
        $DOCKER_COMPOSE_CMD logs -f
    else
        $DOCKER_COMPOSE_CMD logs -f "$service"
    fi
}

cmd_clean() {
    print_header "Cleaning Up"
    print_warning "This will remove all containers and volumes!"
    read -p "Are you sure? (yes/no): " -r response

    if [[ "$response" == "yes" ]]; then
        $DOCKER_COMPOSE_CMD down -v
        print_success "Cleanup completed"
    else
        print_warning "Cleanup cancelled"
    fi
}

cmd_health() {
    print_header "Health Check"

    # Check API Gateway
    if curl -s http://localhost:8081 > /dev/null 2>&1; then
        print_success "API Gateway is responding"
    else
        print_error "API Gateway is not responding"
    fi

    # Check RabbitMQ
    if curl -s -u admin:admin http://localhost:15672/api/overview > /dev/null 2>&1; then
        print_success "RabbitMQ is responding"
    else
        print_error "RabbitMQ is not responding"
    fi

    # Check Redis
    if $DOCKER_COMPOSE_CMD exec -T redis redis-cli -a redispassword ping > /dev/null 2>&1; then
        print_success "Redis is responding"
    else
        print_error "Redis is not responding"
    fi

}

cmd_rebuild() {
    local service=$1
    print_header "Rebuilding Services"

    if [ -z "$service" ]; then
        $DOCKER_COMPOSE_CMD up -d --build
        print_success "All services rebuilt"
    else
        $DOCKER_COMPOSE_CMD up -d --build "$service"
        print_success "$service rebuilt"
    fi
}

cmd_help() {
    cat << EOF
${BLUE}VietFlood Docker Deployment Helper${NC}

Usage: ./deploy.sh [COMMAND] [OPTIONS]

Commands:
    build          Build Docker images
    start          Start all services
    stop           Stop all services
    restart        Restart all services
    status         Show service status
    logs [service] Show logs (specify service for specific logs)
    health         Check health of all services
    clean          Remove all containers and volumes (WARNING)
    rebuild [srv]  Rebuild services (optionally specify service)
    help           Show this help message

Examples:
    ./deploy.sh start
    ./deploy.sh logs vietflood
    ./deploy.sh rebuild vietflood
    ./deploy.sh health

Environment:
    Uses ${GREEN}${ENV_FILE}${NC} for environment variables

EOF
}

# Main script
main() {
    check_docker

    if [ $# -eq 0 ]; then
        cmd_help
        exit 0
    fi

    case "$1" in
        build)
            cmd_build
            ;;
        start)
            cmd_start
            ;;
        stop)
            cmd_stop
            ;;
        restart)
            cmd_restart
            ;;
        status)
            cmd_status
            ;;
        logs)
            cmd_logs "$2"
            ;;
        health)
            cmd_health
            ;;
        clean)
            cmd_clean
            ;;
        rebuild)
            cmd_rebuild "$2"
            ;;
        help)
            cmd_help
            ;;
        *)
            print_error "Unknown command: $1"
            cmd_help
            exit 1
            ;;
    esac
}

main "$@"

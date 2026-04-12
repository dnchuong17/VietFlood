#!/bin/bash

# VietFlood Docker Quick Setup Script
# This script automates the initial setup for Docker deployment

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}VietFlood Docker Setup${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Check Docker installation
echo -e "${BLUE}Checking Docker installation...${NC}"
if ! command -v docker &> /dev/null; then
    echo -e "${YELLOW}✗ Docker is not installed${NC}"
    echo "Please install Docker from https://www.docker.com/products/docker-desktop"
    exit 1
fi
echo -e "${GREEN}✓ Docker is installed${NC}"

# Check Docker Compose
if ! command -v docker-compose &> /dev/null; then
    if docker compose version &> /dev/null; then
        echo -e "${GREEN}✓ Docker Compose is available (via 'docker compose')${NC}"
    else
        echo -e "${YELLOW}✗ Docker Compose is not installed${NC}"
        exit 1
    fi
else
    echo -e "${GREEN}✓ Docker Compose is installed${NC}"
fi

echo ""

# Check .env
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}✗ .env not found${NC}"
    exit 1
else
    echo -e "${GREEN}✓ .env found${NC}"
fi

echo ""

# Build images
echo -e "${BLUE}Building Docker images...${NC}"
echo "(This may take several minutes on first run)"
echo ""

if command -v docker-compose &> /dev/null; then
    docker-compose build
else
    docker compose build
fi

echo ""
echo -e "${GREEN}✓ Docker images built successfully${NC}"

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}Setup Complete!${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "Next steps:"
echo ""
echo "1. Review and update .env with your values:"
echo "   nano .env"
echo ""
echo "2. Start the services:"
echo "   ./deploy.sh start"
echo ""
echo "3. Check service status:"
echo "   ./deploy.sh status"
echo ""
echo "4. Check service health:"
echo "   ./deploy.sh health"
echo ""
echo "API Gateway will be available at: http://localhost:8081"
echo "RabbitMQ Dashboard: http://localhost:15672 (admin/admin)"
echo ""
echo "For more commands, run:"
echo "   ./deploy.sh help"
echo ""

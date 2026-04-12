#!/bin/bash

# VietFlood Docker Implementation Verification Checklist
# Run this script to verify all deployment files are in place

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}VietFlood Docker Implementation Check${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

TOTAL_CHECKS=0
PASSED_CHECKS=0

check_file() {
    local file=$1
    local description=$2

    TOTAL_CHECKS=$((TOTAL_CHECKS + 1))

    if [ -f "$file" ]; then
        echo -e "${GREEN}✓${NC} $file"
        echo "   $description"
        PASSED_CHECKS=$((PASSED_CHECKS + 1))
    else
        echo -e "${RED}✗${NC} $file - NOT FOUND"
        echo "   $description"
    fi
}

check_directory() {
    local dir=$1
    local description=$2

    TOTAL_CHECKS=$((TOTAL_CHECKS + 1))

    if [ -d "$dir" ]; then
        echo -e "${GREEN}✓${NC} $dir/"
        echo "   $description"
        PASSED_CHECKS=$((PASSED_CHECKS + 1))
    else
        echo -e "${RED}✗${NC} $dir/ - NOT FOUND"
        echo "   $description"
    fi
}

check_executable() {
    local file=$1
    local description=$2

    TOTAL_CHECKS=$((TOTAL_CHECKS + 1))

    if [ -x "$file" ]; then
        echo -e "${GREEN}✓${NC} $file (executable)"
        echo "   $description"
        PASSED_CHECKS=$((PASSED_CHECKS + 1))
    elif [ -f "$file" ]; then
        echo -e "${YELLOW}⚠${NC} $file (not executable)"
        echo "   $description - Run: chmod +x $file"
    else
        echo -e "${RED}✗${NC} $file - NOT FOUND"
        echo "   $description"
    fi
}

echo -e "${BLUE}Checking Docker Configuration Files...${NC}"
echo ""
check_file "docker-compose.yml" "Unified deployment configuration"
check_file ".dockerignore" "Docker build context optimization"
echo ""

echo -e "${BLUE}Checking Environment Configuration Files...${NC}"
echo ""
check_file ".env" "Environment configuration"
echo ""

echo -e "${BLUE}Checking Deployment Scripts...${NC}"
echo ""
check_executable "deploy.sh" "Deployment helper script"
check_executable "setup.sh" "Initial setup automation script"
echo ""

echo -e "${BLUE}Checking Documentation Files...${NC}"
echo ""
check_file "DOCKER_DEPLOYMENT.md" "Detailed deployment guide"
check_file "DOCKER_README.md" "Overview and reference guide"
check_file "IMPLEMENTATION_SUMMARY.md" "Implementation summary"
echo ""

echo -e "${BLUE}Checking Application Dockerfiles...${NC}"
echo ""
check_file "apps/api-gateway/Dockerfile" "API Gateway Dockerfile"
check_file "apps/auth-service/Dockerfile" "Auth Service Dockerfile"
check_file "apps/reports-service/Dockerfile" "Reports Service Dockerfile"
echo ""

echo -e "${BLUE}Checking Updated Application Files...${NC}"
echo ""
check_file "apps/auth-service/src/main.ts" "Auth Service with RABBITMQ_URL env support"
check_file "apps/reports-service/src/main.ts" "Reports Service with RABBITMQ_URL env support"
check_file "package.json" "Build scripts added to package.json"
echo ""

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "Verification Results: ${GREEN}${PASSED_CHECKS}/${TOTAL_CHECKS}${NC} checks passed"
echo -e "${BLUE}========================================${NC}"
echo ""

if [ $PASSED_CHECKS -eq $TOTAL_CHECKS ]; then
    echo -e "${GREEN}✓ All files are in place!${NC}"
    echo ""
    echo "Next steps:"
    echo "1. Review configuration:"
    echo "   nano .env"
    echo ""
    echo "2. Build Docker images:"
    echo "   ./setup.sh"
    echo ""
    echo "3. Start services:"
    echo "   ./deploy.sh start"
    echo ""
    echo "4. Check status:"
    echo "   ./deploy.sh health"
    echo ""
else
    echo -e "${RED}✗ Some files are missing!${NC}"
    echo ""
    echo "Please ensure all files have been created."
    echo "Run the implementation again if needed."
    echo ""
    exit 1
fi

echo ""
echo -e "${BLUE}Documentation:${NC}"
echo "- Quick Start: See DOCKER_README.md"
echo "- Detailed Guide: See DOCKER_DEPLOYMENT.md"
echo "- Implementation: See IMPLEMENTATION_SUMMARY.md"
echo ""

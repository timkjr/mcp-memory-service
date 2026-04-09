#!/bin/bash
# MCP Memory Service Update Script
# Safely updates the service after git pull

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
REPO_DIR="/home/timkjr/mcp-memory-service"
SERVICE_NAME="mcp-memory-http.service"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}MCP Memory Service Update Script${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Step 1: Navigate to repository
echo -e "${YELLOW}📁 Navigating to repository...${NC}"
cd "$REPO_DIR" || {
    echo -e "${RED}❌ Failed to navigate to $REPO_DIR${NC}"
    exit 1
}
echo -e "${GREEN}✓ In directory: $(pwd)${NC}"
echo ""

# Step 2: Backup .env file
echo -e "${YELLOW}💾 Backing up .env file...${NC}"
if [ -f .env ]; then
    cp .env .env.backup.$(date +%Y%m%d-%H%M%S)
    echo -e "${GREEN}✓ Backup created${NC}"
else
    echo -e "${YELLOW}⚠ No .env file found (skipping backup)${NC}"
fi
echo ""

# Step 3: Pull latest changes
echo -e "${YELLOW}📥 Pulling latest changes from origin/main...${NC}"
BEFORE_COMMIT=$(git rev-parse HEAD)
git fetch origin && git reset --hard origin/main || {
    echo -e "${RED}❌ Git pull failed${NC}"
    exit 1
}
AFTER_COMMIT=$(git rev-parse HEAD)

if [ "$BEFORE_COMMIT" = "$AFTER_COMMIT" ]; then
    echo -e "${GREEN}✓ Already up to date${NC}"
else
    echo -e "${GREEN}✓ Updated from $BEFORE_COMMIT to $AFTER_COMMIT${NC}"
    echo ""
    echo -e "${BLUE}Recent changes:${NC}"
    git log --oneline "$BEFORE_COMMIT".."$AFTER_COMMIT"
fi
echo ""

# Step 4: Check if dependencies changed
echo -e "${YELLOW}🔍 Checking for dependency changes...${NC}"
if git diff "$BEFORE_COMMIT" "$AFTER_COMMIT" --quiet -- pyproject.toml requirements.txt 2>/dev/null; then
    echo -e "${GREEN}✓ No dependency changes detected${NC}"
    DEPS_CHANGED=false
else
    echo -e "${YELLOW}⚠ Dependencies changed - will reinstall${NC}"
    DEPS_CHANGED=true
fi
echo ""

# Step 5: Activate virtual environment and update dependencies
echo -e "${YELLOW}📦 Updating Python dependencies...${NC}"
if [ ! -d "venv" ]; then
    echo -e "${RED}❌ Virtual environment not found at $REPO_DIR/venv${NC}"
    exit 1
fi

source venv/bin/activate || {
    echo -e "${RED}❌ Failed to activate virtual environment${NC}"
    exit 1
}

# Always run pip install -e . to ensure editable install is current
echo -e "${BLUE}Running: pip install -e .${NC}"
pip install -e . -q || {
    echo -e "${RED}❌ Failed to install dependencies${NC}"
    exit 1
}
echo -e "${GREEN}✓ Dependencies updated${NC}"
echo ""

# Step 6: Restart the service
echo -e "${YELLOW}♻️  Restarting systemd service...${NC}"
systemctl --user restart "$SERVICE_NAME" || {
    echo -e "${RED}❌ Failed to restart service${NC}"
    echo -e "${YELLOW}Checking service status:${NC}"
    systemctl --user status "$SERVICE_NAME" --no-pager || true
    exit 1
}
echo -e "${GREEN}✓ Service restarted${NC}"
echo ""

# Step 7: Wait for service to start
echo -e "${YELLOW}⏳ Waiting for service to start...${NC}"
sleep 3

# Step 8: Verify service is running
echo -e "${YELLOW}✅ Verifying service status...${NC}"
if systemctl --user is-active --quiet "$SERVICE_NAME"; then
    echo -e "${GREEN}✓ Service is active and running${NC}"
else
    echo -e "${RED}❌ Service is not active${NC}"
    systemctl --user status "$SERVICE_NAME" --no-pager
    exit 1
fi
echo ""

# Step 9: Health check
echo -e "${YELLOW}🏥 Performing health check...${NC}"
HEALTH_EXIT=1
for i in 1 2 3 4 5; do
    HEALTH_OUTPUT=$(curl -s http://127.0.0.1:8000/api/health 2>&1)
    HEALTH_EXIT=$?
    [ $HEALTH_EXIT -eq 0 ] && break
    echo -e "${YELLOW}  Waiting for service... (attempt $i/5)${NC}"
    sleep 5
done

if [ $HEALTH_EXIT -eq 0 ]; then
    echo -e "${GREEN}✓ Health check passed${NC}"
    echo ""
    echo -e "${BLUE}Service Info:${NC}"
    echo "$HEALTH_OUTPUT" | python -m json.tool 2>/dev/null || echo "$HEALTH_OUTPUT"
else
    echo -e "${RED}❌ Health check failed${NC}"
    echo "Error: $HEALTH_OUTPUT"
    echo ""
    echo -e "${YELLOW}Service logs (last 20 lines):${NC}"
    journalctl --user -u "$SERVICE_NAME" -n 20 --no-pager
    exit 1
fi
echo ""

# Summary
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}✨ Update completed successfully!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${BLUE}Useful commands:${NC}"
echo "  Status:  systemctl --user status $SERVICE_NAME"
echo "  Logs:    journalctl --user -u $SERVICE_NAME -f"
echo "  Health:  curl http://127.0.0.1:8000/api/health"
echo ""

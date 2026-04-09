#!/bin/bash
# Update script to deploy sync-claude-hooks-refactored.sh to all nodes
# This script ensures all nodes have the latest sync logic for Hooks and Commands

set -euo pipefail

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_success() {
    echo -e "${BLUE}[SUCCESS]${NC} $1"
}

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REFACTORED_SYNC="$SCRIPT_DIR/sync-claude-hooks-refactored.sh"
DEPLOY_SCRIPT="$SCRIPT_DIR/deploy-hooks-to-nfs.sh"

# Nodes to update (add/remove as needed)
NODES=(
    "development"
    "docker-vm"
    "proxx"
    "paperless-ngx"
    "mcp-memory"
)

log_info "Update Nodes: Sync Script Deployment"
log_info "====================================="
echo

# Validation
if [ ! -f "$REFACTORED_SYNC" ]; then
    log_error "Refactored sync script not found: $REFACTORED_SYNC"
    exit 1
fi

# Step 1: Test on one node first
log_info "Testing on first node (${NODES[0]})"
TEST_NODE="${NODES[0]}"

log_info "Deploying updated sync script to $TEST_NODE..."
if scp "$REFACTORED_SYNC" "$TEST_NODE:~/.local/bin/sync-claude-hooks.sh"; then
    ssh "$TEST_NODE" "chmod +x ~/.local/bin/sync-claude-hooks.sh"
    log_success "Deployed script to $TEST_NODE"
else
    log_error "Failed to deploy script to $TEST_NODE"
    exit 1
fi

log_info "Running sync on $TEST_NODE..."
SYNC_OUTPUT=$(ssh "$TEST_NODE" "~/.local/bin/sync-claude-hooks.sh" 2>&1)
SYNC_EXIT=$?

# Check for success message or exit code
if [ $SYNC_EXIT -eq 0 ]; then
    log_success "Sync execution completed on $TEST_NODE"
    # echo "$SYNC_OUTPUT" | head -n 5 
else
    log_error "Sync script failed on $TEST_NODE (exit code: $SYNC_EXIT)"
    log_info "Output: $SYNC_OUTPUT"
    exit 1
fi

# Check actual installation results
log_info "Verifying installation on $TEST_NODE..."
VERIFY_FAILED=0

# Check 1: Hooks .sync-version exists
if ! ssh "$TEST_NODE" "test -f ~/.claude/hooks/.sync-version"; then
    log_warn "Hooks .sync-version file not found"
    VERIFY_FAILED=1
else
    log_success "Hooks sync verified"
fi

# Check 2: Commands .sync-version exists
if ! ssh "$TEST_NODE" "test -f ~/.claude/commands/.sync-version"; then
    log_warn "Commands .sync-version file not found (Commands may not have synced)"
    VERIFY_FAILED=1
else
    log_success "Commands sync verified"
fi

# Check 3: Check for a command file
if ssh "$TEST_NODE" "find ~/.claude/commands -name '*.md' | grep -q ."; then
     log_success "Command files found on $TEST_NODE"
else
     log_warn "No command files found in ~/.claude/commands"
fi

if [ $VERIFY_FAILED -ne 0 ]; then
    log_error "Verification failed on $TEST_NODE"
    log_info "Sync may have partially failed. Check manually."
    exit 1
fi

log_success "Verification passed on $TEST_NODE"
echo

# Step 3: Deploy to remaining nodes
log_info "Step 3: Deploy to remaining nodes"
log_warn "This will update sync script on: ${NODES[*]:1}"
echo
read -p "Deploy to all remaining nodes? (y/N): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    log_warn "Cancelled - only test node was updated"
    exit 0
fi

FAILED_NODES=()
SUCCESS_COUNT=0

# Disable exit on error for the loop
set +e

for node in "${NODES[@]:1}"; do  # Skip first node (already done)
    log_info "Updating $node..."

    # Deploy script
    if ! scp -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$REFACTORED_SYNC" "$node:~/.local/bin/sync-claude-hooks.sh" 2>&1; then
        log_error "Cannot reach $node (scp failed) - skipping"
        FAILED_NODES+=("$node")
        continue
    fi

    # Run sync script
    SYNC_OUTPUT=$(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$node" "chmod +x ~/.local/bin/sync-claude-hooks.sh && ~/.local/bin/sync-claude-hooks.sh" 2>&1)
    SYNC_EXIT=$?

    # Verify success
    if [ $SYNC_EXIT -eq 0 ]; then
        # Quick verification check
        if ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$node" "test -f ~/.claude/hooks/.sync-version && test -f ~/.claude/commands/.sync-version"; then
            log_success "Updated $node successfully"
            ((SUCCESS_COUNT++))
        else
            log_warn "$node sync completed but verification failed"
            FAILED_NODES+=("$node")
        fi
    else
        log_error "Failed to update $node (exit: $SYNC_EXIT)"
        log_info "Output: $SYNC_OUTPUT"
        FAILED_NODES+=("$node")
    fi
done

# Re-enable exit on error
set -e


# Summary
echo
log_info "============================================"
log_info "Update Summary"
log_info "============================================"
log_success "Successfully updated: $((SUCCESS_COUNT + 1)) nodes"

if [ ${#FAILED_NODES[@]} -gt 0 ]; then
    log_error "Failed nodes: ${FAILED_NODES[*]}"
    log_info "Retry manually for failed nodes."
else
    log_success "All nodes updated successfully!"
fi
echo

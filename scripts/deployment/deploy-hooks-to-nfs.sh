#!/bin/bash
# Deploy Natural Memory Triggers hooks, Claude Commands, and OpenCode plugin to NFS canonical location
# Run this script from within your mcp-memory-service repository (or provide path as argument)
#
# Usage:
#   ./deploy-hooks-to-nfs.sh [/path/to/mcp-memory-service]
#
# This script copies:
#   1. claude-hooks/ -> /mnt/nas/claude/hooks-canonical/
#   2. claude_commands/ -> /mnt/nas/claude/commands-canonical/
#   3. opencode/ -> /mnt/nas/claude/opencode-canonical/
# and creates VERSION files in each to trigger smart sync on all nodes

set -euo pipefail

# Configuration
NFS_HOOKS_CANONICAL="/mnt/nas/claude/hooks-canonical"
NFS_COMMANDS_CANONICAL="/mnt/nas/claude/commands-canonical"
NFS_OPENCODE_CANONICAL="/mnt/nas/claude/opencode-canonical"

# Determine paths based on input or defaults
BASE_DIR="${1:-/home/timkjr/mcp-memory-service}"
HOOKS_SOURCE="$BASE_DIR/claude-hooks"
COMMANDS_SOURCE="$BASE_DIR/claude_commands"
OPENCODE_SOURCE="$BASE_DIR/opencode"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_section() {
    echo -e "\n${CYAN}=== $1 ===${NC}"
}

# Validation
log_section "Validating environment"

# Check if sources exist
if [ ! -d "$HOOKS_SOURCE" ]; then
    log_error "Hooks source directory not found: $HOOKS_SOURCE"
    log_error "Usage: $0 [/path/to/mcp-memory-service]"
    exit 1
fi

if [ ! -d "$COMMANDS_SOURCE" ]; then
    log_error "Commands source directory not found: $COMMANDS_SOURCE"
    exit 1
fi

if [ ! -d "$OPENCODE_SOURCE" ]; then
    log_error "OpenCode source directory not found: $OPENCODE_SOURCE"
    exit 1
fi

# Check if required hooks subdirectories exist
if [ ! -d "$HOOKS_SOURCE/core" ] || [ ! -d "$HOOKS_SOURCE/utilities" ]; then
    log_error "Invalid hooks directory structure. Expected:"
    log_error "  $HOOKS_SOURCE/core/"
    log_error "  $HOOKS_SOURCE/utilities/"
    exit 1
fi

# Check/Create NFS directories
for DIR in "$NFS_HOOKS_CANONICAL" "$NFS_COMMANDS_CANONICAL" "$NFS_OPENCODE_CANONICAL"; do
    if [ ! -d "$DIR" ]; then
        log_warn "Directory $DIR does not exist, attempting to create..."
        if ! mkdir -p "$DIR" 2>/dev/null; then
             log_warn "mkdir failed, trying with sudo..."
             sudo mkdir -p "$DIR"
             sudo chown claude:claude "$DIR"
        fi
    fi

    if [ ! -w "$DIR" ]; then
        log_error "Cannot write to NFS directory: $DIR"
        log_error "Check permissions or run with appropriate privileges"
        exit 1
    fi
done

# Count files to be deployed
HOOK_FILE_COUNT=$(find "$HOOKS_SOURCE" -type f -name "*.js" -o -name "*.json" | wc -l)
COMMAND_FILE_COUNT=$(find "$COMMANDS_SOURCE" -type f -name "*.md" | wc -l)
OPENCODE_FILE_COUNT=$(find "$OPENCODE_SOURCE" -type f \( -name "*.js" -o -name "*.json" \) | wc -l)
log_info "Found $HOOK_FILE_COUNT hook files, $COMMAND_FILE_COUNT command files, and $OPENCODE_FILE_COUNT opencode files"

# Confirm deployment
echo
echo "=== Deployment Summary ==="
echo "Hooks Source:     $HOOKS_SOURCE"
echo "Hooks Dest:       $NFS_HOOKS_CANONICAL"
echo "Hooks Files:      $HOOK_FILE_COUNT"
echo "--------------------------"
echo "Commands Source:  $COMMANDS_SOURCE"
echo "Commands Dest:    $NFS_COMMANDS_CANONICAL"
echo "Commands Files:   $COMMAND_FILE_COUNT"
echo "--------------------------"
echo "OpenCode Source:  $OPENCODE_SOURCE"
echo "OpenCode Dest:    $NFS_OPENCODE_CANONICAL"
echo "OpenCode Files:   $OPENCODE_FILE_COUNT"
echo "=========================="
echo

read -p "Proceed with deployment? (y/N): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    log_warn "Deployment cancelled by user"
    exit 0
fi

# Function to backup directory
backup_dir() {
    local dir=$1
    if [ -d "$dir" ] && [ "$(ls -A $dir 2>/dev/null)" ]; then
        local backup_name
        backup_name=$(basename "$dir")
        local backup_path="/tmp/${backup_name}-backup.$(date +%Y%m%d-%H%M%S)"
        log_info "Creating backup of $dir to $backup_path"
        cp -a "$dir" "$backup_path" || log_warn "Backup failed, continuing anyway..."
    fi
}

# Function to create VERSION file
create_version_file() {
    local dir=$1
    local source=$2
    local version_file="$dir/VERSION"
    
    log_info "Creating VERSION file in $dir..."
    {
        echo "Deployment timestamp: $(date -Iseconds)"
        echo "Deployed by: $(whoami)@$(hostname)"

        # Try to get git commit info
        if [ -d "$source/../.git" ]; then
            cd "$source/.." || true
            echo "Git commit: $(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
            echo "Git branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown')"
        fi

        echo "File count: $(find "$dir" -type f | wc -l)"
    } > "$version_file"
}

# ------------------------------------------------------------------
# Deploy Hooks
# ------------------------------------------------------------------
log_section "Deploying Hooks"

backup_dir "$NFS_HOOKS_CANONICAL"

log_info "Syncing hooks..."
rsync -av --delete \
    --exclude='.git' \
    --exclude='*.backup' \
    --exclude='.sync-version' \
    "$HOOKS_SOURCE/" "$NFS_HOOKS_CANONICAL/" 2>&1 | while read line; do
    log_info "  $line"
done

if [ ${PIPESTATUS[0]} -ne 0 ]; then
    log_error "Hooks deployment failed during rsync"
    exit 1
fi

create_version_file "$NFS_HOOKS_CANONICAL" "$HOOKS_SOURCE"

# ------------------------------------------------------------------
# Deploy Commands
# ------------------------------------------------------------------
log_section "Deploying Commands"

backup_dir "$NFS_COMMANDS_CANONICAL"

log_info "Syncing commands..."
rsync -av --delete \
    --exclude='.git' \
    --exclude='*.backup' \
    --exclude='VERSION' \
    "$COMMANDS_SOURCE/" "$NFS_COMMANDS_CANONICAL/" 2>&1 | while read line; do
    log_info "  $line"
done

if [ ${PIPESTATUS[0]} -ne 0 ]; then
    log_error "Commands deployment failed during rsync"
    exit 1
fi

create_version_file "$NFS_COMMANDS_CANONICAL" "$COMMANDS_SOURCE"

# ------------------------------------------------------------------
# Deploy OpenCode Plugin
# ------------------------------------------------------------------
log_section "Deploying OpenCode Plugin"

backup_dir "$NFS_OPENCODE_CANONICAL"

log_info "Syncing opencode plugin..."
rsync -av --delete \
    --exclude='.git' \
    --exclude='*.backup' \
    --exclude='VERSION' \
    "$OPENCODE_SOURCE/" "$NFS_OPENCODE_CANONICAL/" 2>&1 | while read line; do
    log_info "  $line"
done

if [ ${PIPESTATUS[0]} -ne 0 ]; then
    log_error "OpenCode plugin deployment failed during rsync"
    exit 1
fi

create_version_file "$NFS_OPENCODE_CANONICAL" "$OPENCODE_SOURCE"

# ------------------------------------------------------------------
# Finalize
# ------------------------------------------------------------------
log_section "Finalizing"

# Set proper permissions (skip chown on NFS, just set modes)
chmod -R u+rwX,g+rX,o+rX "$NFS_HOOKS_CANONICAL" 2>/dev/null || true
chmod -R u+rwX,g+rX,o+rX "$NFS_COMMANDS_CANONICAL" 2>/dev/null || true
chmod -R u+rwX,g+rX,o+rX "$NFS_OPENCODE_CANONICAL" 2>/dev/null || true

# Verify deployment
log_info "Verifying deployment..."

DEPLOYED_HOOKS=$(find "$NFS_HOOKS_CANONICAL" -type f -name "*.js" -o -name "*.json" | wc -l)
DEPLOYED_COMMANDS=$(find "$NFS_COMMANDS_CANONICAL" -type f -name "*.md" | wc -l)
DEPLOYED_OPENCODE=$(find "$NFS_OPENCODE_CANONICAL" -type f \( -name "*.js" -o -name "*.json" \) | wc -l)

if [ $DEPLOYED_HOOKS -lt 10 ]; then
    log_warn "Warning: Only $DEPLOYED_HOOKS hook files deployed, expected more"
fi
if [ $DEPLOYED_COMMANDS -lt 1 ]; then
    log_warn "Warning: No command files deployed!"
fi
if [ $DEPLOYED_OPENCODE -lt 1 ]; then
    log_warn "Warning: No opencode files deployed!"
fi

log_info "✅ Deployment complete!"
log_info "  - Hooks:    $NFS_HOOKS_CANONICAL ($DEPLOYED_HOOKS files)"
log_info "  - Commands: $NFS_COMMANDS_CANONICAL ($DEPLOYED_COMMANDS files)"
log_info "  - OpenCode: $NFS_OPENCODE_CANONICAL ($DEPLOYED_OPENCODE files)"
log_info "All Claude Code nodes will sync automatically within the next hour"
log_info "Or trigger immediate sync on a node with: ~/.local/bin/sync-claude-hooks.sh"

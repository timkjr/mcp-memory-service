#!/usr/bin/env bash
# Deploy mcp-memory-service to mcp-memory.k-lab.lan
#
# Usage:
#   ./deploy.sh              — push to Forgejo + deploy service + deploy hooks
#   ./deploy.sh --mirror     — push to Forgejo + mirror to GitHub fork + deploy
#   ./deploy.sh --sync       — merge upstream (doobidoo) first, then deploy
#   ./deploy.sh --sync --mirror — sync + mirror to GitHub + deploy
#
set -euo pipefail

REMOTE_HOST="timkjr@mcp-memory.k-lab.lan"
REMOTE_USER="timkjr"
REMOTE_BASE="/home/$REMOTE_USER/mcp-memory-service/scripts/deployment"
MIRROR=false
SYNC=false
LOG_FILE="/tmp/deploy-$(date +%Y%m%d-%H%M%S).log"

for arg in "$@"; do
  case "$arg" in
    --mirror) MIRROR=true ;;
    --sync)   SYNC=true ;;
  esac
done

if $SYNC; then
  echo "→ Fetching upstream (doobidoo/mcp-memory-service)..."
  git fetch upstream
  echo "→ Merging upstream/main into main..."
  git merge upstream/main --no-edit
fi

echo "→ Pushing to Forgejo (primary)..."
git push forgejo main --tags

if $MIRROR; then
  echo "→ Mirroring to GitHub fork..."
  git push github main --force-with-lease --tags
fi

echo "→ Deploying to mcp-memory.k-lab.lan..."
echo "→ Log file: $LOG_FILE"

{
  echo "=== Deployment started at $(date) ==="
  echo ""

  echo "→ Updating service..."
  ssh "$REMOTE_HOST" "bash $REMOTE_BASE/update-mcp-memory.sh" || true
  echo ""

  echo "→ Deploying hooks to NFS..."
  ssh "$REMOTE_HOST" "yes | bash $REMOTE_BASE/deploy-hooks-to-nfs.sh" || true
  echo ""

  echo "→ Updating nodes..."
  ssh "$REMOTE_HOST" "yes | bash $REMOTE_BASE/update-nodes.sh" || true
  echo ""

  echo "=== Deployment completed at $(date) ==="
} 2>&1 | tee "$LOG_FILE"

echo ""
echo "✓ Done. Full log: $LOG_FILE"

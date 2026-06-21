#!/usr/bin/env bash
# Deploy mcp-memory-service to mcp-memory.k-lab.lan
#
# Usage:
#   ./deploy.sh              — push tlkMods to Forgejo + deploy
#   ./deploy.sh --mirror     — push tlkMods to Forgejo + mirror to GitHub + deploy
#   ./deploy.sh --sync       — rebase tlkMods on upstream/main first, then deploy
#   ./deploy.sh --sync --mirror — sync + mirror to GitHub + deploy
#
# Branch strategy:
#   main      = clean mirror of upstream/main  (never commit here)
#   tlkMods   = fork customizations             (active development, deployed)
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
  git fetch upstream --tags --prune-tags
  echo "→ Fast-forwarding main to upstream/main..."
  git branch -f main upstream/main
  echo "→ Rebasing tlkMods on updated main..."
  git rebase main
fi

# Ensure we're on tlkMods to push
git checkout tlkMods

echo "→ Pushing tlkMods to Forgejo as main..."
git push forgejo tlkMods:main --force-with-lease --tags

if $MIRROR; then
  echo "→ Mirroring to GitHub fork..."
  git push github tlkMods:main --force-with-lease --tags
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

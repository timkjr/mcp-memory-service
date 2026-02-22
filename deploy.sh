#!/usr/bin/env bash
# Deploy mcp-memory-service to mcp-memory.k-lab.lan
#
# Usage:
#   ./deploy.sh              — push current branch + deploy
#   ./deploy.sh --sync       — fetch upstream doobidoo, merge, push, deploy
#   ./deploy.sh --sync-only  — sync upstream without deploying
#
set -euo pipefail

REMOTE_HOST="timkjr@mcp-memory.k-lab.lan"
REMOTE_SCRIPT="~/deploy-mcp-memory/update-mcp-memory.sh"
SYNC=false
DEPLOY=true

for arg in "$@"; do
  case "$arg" in
    --sync)      SYNC=true ;;
    --sync-only) SYNC=true; DEPLOY=false ;;
  esac
done

if $SYNC; then
  echo "→ Fetching upstream (doobidoo)..."
  git fetch upstream
  echo "→ Rebasing onto upstream/main..."
  git rebase upstream/main
  echo "→ Mirroring to GitHub fork..."
  git fetch github
  git push github main --force-with-lease --tags
fi

echo "→ Pushing to Forgejo (primary)..."
FORCE_FLAG=$($SYNC && echo "--force-with-lease" || true)
git push forgejo main $FORCE_FLAG --tags

if $DEPLOY; then
  echo "→ Deploying to mcp-memory.k-lab.lan..."
  ssh "$REMOTE_HOST" "bash $REMOTE_SCRIPT"
  echo "✓ Done"
fi

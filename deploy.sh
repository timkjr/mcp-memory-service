#!/usr/bin/env bash
# Deploy mcp-memory-service to mcp-memory.k-lab.lan
#
# Usage:
#   ./deploy.sh              — push to Forgejo + deploy
#   ./deploy.sh --mirror     — push to Forgejo + mirror to GitHub fork + deploy
#   ./deploy.sh --sync       — merge upstream (doobidoo) first, then deploy
#   ./deploy.sh --sync --mirror — sync + mirror to GitHub + deploy
#
set -euo pipefail

REMOTE_HOST="timkjr@mcp-memory.k-lab.lan"
REMOTE_SCRIPT="~/deploy-mcp-memory/update-mcp-memory.sh"
MIRROR=false
SYNC=false

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
ssh "$REMOTE_HOST" "bash $REMOTE_SCRIPT"
echo "✓ Done"

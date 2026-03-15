#!/usr/bin/env bash
# Deploy mcp-memory-service to mcp-memory.k-lab.lan
#
# Usage:
#   ./deploy.sh              — push to Forgejo + deploy
#   ./deploy.sh --mirror     — push to Forgejo + mirror to GitHub fork + deploy
#
# Note: upstream (doobidoo/mcp-memory-service) no longer exists.
# This is now an independent fork. The --sync flag has been removed.
#
set -euo pipefail

REMOTE_HOST="timkjr@mcp-memory.k-lab.lan"
REMOTE_SCRIPT="~/deploy-mcp-memory/update-mcp-memory.sh"
MIRROR=false

for arg in "$@"; do
  case "$arg" in
    --mirror) MIRROR=true ;;
  esac
done

echo "→ Pushing to Forgejo (primary)..."
git push forgejo main --tags

if $MIRROR; then
  echo "→ Mirroring to GitHub fork..."
  git push github main --force-with-lease --tags
fi

echo "→ Deploying to mcp-memory.k-lab.lan..."
ssh "$REMOTE_HOST" "bash $REMOTE_SCRIPT"
echo "✓ Done"

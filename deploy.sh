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
  # Skip LFS smudge during sync — upstream LFS objects may not be available on Codeberg (404)
  export GIT_LFS_SKIP_SMUDGE=1
  git fetch upstream --tags --prune-tags
  echo "→ Fast-forwarding main to upstream/main..."
  git branch -f main upstream/main
  echo "→ Rebasing tlkMods on updated main..."
  git stash push --include-untracked -m "deploy-sync-auto" 2>/dev/null || true
  _rebased=false
  _max_attempts=10
  for _attempt in $(seq 1 $_max_attempts); do
    if git rebase main; then
      _rebased=true
      break
    fi
    _conflicts=$(git diff --name-only --diff-filter=U)
    if [ -z "$_conflicts" ]; then
      echo "✗ Rebase failed (non-conflict error), aborting."
      git stash pop 2>/dev/null || true
      git rebase --abort
      exit 1
    fi
    echo "→ Resolving conflicts in: $_conflicts"
    # For modify/delete conflicts (upstream added, we deleted), --theirs fails;
    # fall back to git rm so our deletion wins.
    while IFS= read -r _f; do
      if ! git checkout --theirs "$_f" 2>/dev/null; then
        git rm -f "$_f" 2>/dev/null || true
      fi
    done <<< "$_conflicts"
    git add -u
    GIT_EDITOR=true git rebase --continue
  done
  if ! $_rebased; then
    echo "✗ Rebase did not complete after $_max_attempts attempts."
    git stash pop 2>/dev/null || true
    git rebase --abort
    exit 1
  fi
  echo "✓ Rebase complete."
  git stash pop 2>/dev/null || true
  unset GIT_LFS_SKIP_SMUDGE
fi

# Ensure we're on tlkMods to push
git checkout tlkMods

echo "→ Pushing tlkMods to Forgejo as main..."
git push forgejo tlkMods:main --force-with-lease --tags

echo "→ Syncing tlkMods tracking branch..."
git push forgejo tlkMods --force-with-lease

if $MIRROR; then
  echo "→ Mirroring to GitHub fork..."
  git push github tlkMods:main --force-with-lease --tags
fi

echo "→ Deploying to mcp-memory.k-lab.lan..."
echo "→ Log file: $LOG_FILE"

{
  echo "=== Deployment started at $(date) ==="
  echo ""

  echo "→ Syncing hooks to local ~/.claude/hooks/..."
  cp -r claude-hooks/. ~/.claude/hooks/ 2>/dev/null || true
  echo ""

  echo "→ Committing changed hook files to dotfiles..."
  (
    cd ~/dotfiles
    git stash push --include-untracked -m "deploy-hook-sync" 2>/dev/null || true
    git pull --rebase
    git stash pop 2>/dev/null || true
    git add \
      claude/.claude/hooks/core/mid-conversation.js \
      claude/.claude/hooks/utilities/auto-capture-patterns.js
    git diff --cached --quiet || git commit -m "chore(hooks): sync from mcp-memory deploy"
    git push
  )
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

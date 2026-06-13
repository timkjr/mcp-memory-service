#!/usr/bin/env bash
# Avoid two Claude Code sessions sharing one git working tree.
#
# Two Claude sessions in the same checkout share ONE HEAD and index: a
# `git checkout`/`branch`/`commit` in one moves HEAD under the other, and
# concurrent git ops collide on .git/index.lock.
#
# Consumers:
#   - SessionStart hook (.claude/settings.json)  -> `guard`  (detect + warn + prepare)
#   - zsh claude() wrapper (~/.zshrc)            -> `count` / `prepare` (auto-isolate)
#
# Subcommands:
#   count    : print number of Claude session processes whose cwd is this worktree
#   prepare  : create an isolated sibling worktree (new branch, .venv/.env
#              symlinked), print its absolute path on stdout
#   guard    : if >=2 sessions share this tree, prepare an isolated worktree and
#              print a warning block (for SessionStart additionalContext)
#
# Always exits 0 — this is advisory, it must never block a session.
set -u

root() { git rev-parse --show-toplevel 2>/dev/null; }

# Is pid a Claude Code session? Identify by the resolved EXECUTABLE path, which
# is the only reliable signal across launch methods:
#   - CLI:    ~/.local/share/claude/versions/<ver>   (argv is just "claude",
#             comm is the version string -> pgrep by name is unreliable)
#   - VSCode: .../native-binary/claude
# The Claude *Desktop* app (/Applications/Claude.app/...) must NOT match.
is_claude_session() {
  lsof -a -p "$1" -d txt -Fn 2>/dev/null | sed -n 's/^n//p' \
    | grep -Eq 'claude/versions/|native-binary/claude'
}

# PIDs whose cwd is $1 or a subdirectory of it (one lsof sweep over all procs).
pids_with_cwd_under() {
  lsof -d cwd -Fpn 2>/dev/null | awk -v r="$1" '
    /^p/ { pid = substr($0, 2) }
    /^n/ { d = substr($0, 2); if (d == r || index(d, r "/") == 1) print pid }'
}

# Unique Claude Code session PIDs rooted in worktree $1.
session_pids_in() {
  local wt="$1" p
  pids_with_cwd_under "$wt" | sort -u | while read -r p; do
    [ -n "$p" ] || continue
    is_claude_session "$p" && echo "$p"
  done
}

cmd_count() {
  local r; r="$(root)" || { echo 0; return; }
  session_pids_in "$r" | sort -u | grep -c .
}

cmd_prepare() {
  local r br stamp dest; r="$(root)" || return 1
  br="$(git -C "$r" branch --show-current 2>/dev/null)"
  br="${br:-HEAD}"
  stamp="$(date +%y%m%d-%H%M%S)"
  dest="$(dirname "$r")/$(basename "$r")--wt-$stamp"
  git -C "$r" worktree add -q -b "wt/$stamp" "$dest" "$br" >&2 2>/dev/null || return 1
  # Heavy/secret untracked deps are gitignored -> absent in a fresh worktree.
  [ -e "$r/.venv" ] && [ ! -e "$dest/.venv" ] && ln -s "$r/.venv" "$dest/.venv"
  [ -e "$r/.env" ]  && [ ! -e "$dest/.env" ]  && ln -s "$r/.env"  "$dest/.env"
  echo "$dest"
}

cmd_guard() {
  local r c br dest; r="$(root)" || exit 0
  c="$(cmd_count)"
  [ "${c:-0}" -ge 2 ] || exit 0   # alone in this tree -> nothing to do
  br="$(git -C "$r" branch --show-current 2>/dev/null)"
  dest="$(cmd_prepare 2>/dev/null)" || dest=""
  echo "⚠ WORKTREE COLLISION RISK: $c Claude sessions share this working tree."
  echo "   Tree: $r  (branch: ${br:-detached})"
  echo "   Two sessions here share ONE HEAD+index. A git checkout/branch/commit"
  echo "   in another session will move HEAD under this one, and concurrent git"
  echo "   ops collide on index.lock."
  if [ -n "$dest" ]; then
    echo "   An isolated worktree has been prepared (.venv/.env symlinked):"
    echo "     $dest"
    echo "   -> Open/relaunch Claude there for any git work. .venv is symlinked, so"
    echo "      its editable install still points at the main src; run"
    echo "      'uv pip install -e .' inside the worktree if you need to run its code."
  else
    echo "   Create one with:  git worktree add ../$(basename "$r")--wt -b wt/\$(date +%s)"
  fi
  echo "   Until then: prefer read-only work in THIS tree; avoid checkout/commit."
  exit 0
}

case "${1:-guard}" in
  count)   cmd_count ;;
  prepare) cmd_prepare ;;
  guard)   cmd_guard ;;
  *)       echo "usage: worktree_guard.sh {count|prepare|guard}" >&2; exit 0 ;;
esac

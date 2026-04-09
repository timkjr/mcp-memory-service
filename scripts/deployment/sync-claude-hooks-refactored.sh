#!/bin/bash
# Smart Sync Script for Natural Memory Triggers Hooks, Claude Commands, Skills, and OpenCode Plugin
# Runs proper installation from NFS canonical source when VERSION changes

# Configuration
LOG_TAG="claude-sync"

# Hooks Config
HOOKS_CANONICAL="/mnt/nas/claude/hooks-canonical"
HOOKS_LOCAL="$HOME/.claude/hooks"
HOOKS_CANONICAL_VER="$HOOKS_CANONICAL/VERSION"
HOOKS_LOCAL_VER="$HOOKS_LOCAL/.sync-version"
INSTALL_SCRIPT="$HOOKS_CANONICAL/install_hooks.py"

# Commands Config
COMMANDS_CANONICAL="/mnt/nas/claude/commands-canonical"
COMMANDS_LOCAL="$HOME/.claude/commands"
COMMANDS_CANONICAL_VER="$COMMANDS_CANONICAL/VERSION"
COMMANDS_LOCAL_VER="$COMMANDS_LOCAL/.sync-version"

# Skills Config
SKILLS_CANONICAL="/mnt/nas/claude/skills-canonical"
SKILLS_LOCAL="$HOME/.claude/skills"
SKILLS_CANONICAL_VER="$SKILLS_CANONICAL/VERSION"
SKILLS_LOCAL_VER="$SKILLS_LOCAL/.sync-version"

# OpenCode Config
OPENCODE_CANONICAL="/mnt/nas/claude/opencode-canonical"
OPENCODE_PLUGINS_LOCAL="$HOME/.config/opencode/plugins"
OPENCODE_CONFIG_LOCAL="$HOME/.config/opencode"
OPENCODE_CANONICAL_VER="$OPENCODE_CANONICAL/VERSION"
OPENCODE_LOCAL_VER="$OPENCODE_PLUGINS_LOCAL/.sync-version"

# ==============================================================================
# SYNC HOOKS
# ==============================================================================

# Check if canonical source is available
if [ ! -d "$HOOKS_CANONICAL" ]; then
  logger -t "$LOG_TAG" "ERROR: Canonical hooks directory not found: $HOOKS_CANONICAL"
else
  # Check if install_hooks.py exists
  if [ ! -f "$INSTALL_SCRIPT" ]; then
    logger -t "$LOG_TAG" "WARN: install_hooks.py not found in canonical location: $INSTALL_SCRIPT"
    logger -t "$LOG_TAG" "Falling back to rsync-only mode for hooks"
    
    # Check version for fallback mode
    if [ ! -f "$HOOKS_LOCAL_VER" ] || ! diff -q "$HOOKS_CANONICAL_VER" "$HOOKS_LOCAL_VER" &>/dev/null; then
        rsync -a --delete --exclude='config.json' --exclude='.sync-version' "$HOOKS_CANONICAL/" "$HOOKS_LOCAL/" 2>&1 | logger -t "$LOG_TAG"
        cp "$HOOKS_CANONICAL_VER" "$HOOKS_LOCAL_VER" 2>/dev/null
        logger -t "$LOG_TAG" "Hooks updated via rsync fallback"
    fi
  else
    # Normal installation mode
    # If no local version file, or version mismatch, sync and install
    if [ ! -f "$HOOKS_LOCAL_VER" ] || ! diff -q "$HOOKS_CANONICAL_VER" "$HOOKS_LOCAL_VER" &>/dev/null; then
      logger -t "$LOG_TAG" "Hooks version change detected, running installation..."

      # Create a temporary log file for installation output
      INSTALL_LOG=$(mktemp /tmp/claude-hooks-install.XXXXXX.log)

      cd "$HOOKS_CANONICAL" || {
        logger -t "$LOG_TAG" "ERROR: Could not cd to $HOOKS_CANONICAL"
      }

      # Run installer and capture output to log file
      if [ -d "$HOOKS_CANONICAL" ]; then
          python3 "$INSTALL_SCRIPT" --all > "$INSTALL_LOG" 2>&1
          INSTALL_EXIT=$?

          # Log the output
          cat "$INSTALL_LOG" | logger -t "$LOG_TAG"

          if [ $INSTALL_EXIT -eq 0 ]; then
            # Installation succeeded
            cp "$HOOKS_CANONICAL_VER" "$HOOKS_LOCAL_VER"
            logger -t "$LOG_TAG" "Hooks installed successfully"
            echo "SUCCESS: Hooks installed successfully (log: $INSTALL_LOG)"

            # Optionally, clean up old log files (keep last 5)
            find /tmp -name "claude-hooks-install.*.log" -type f -mtime +7 -delete 2>/dev/null
          else
            logger -t "$LOG_TAG" "ERROR: Hooks installation failed with exit code $INSTALL_EXIT"
            echo "ERROR: Hooks installation failed (log: $INSTALL_LOG)" >&2
          fi
      fi
    else
      logger -t "$LOG_TAG" "Hooks already up to date"
    fi
  fi
fi

# ==============================================================================
# SYNC COMMANDS
# ==============================================================================

if [ ! -d "$COMMANDS_CANONICAL" ]; then
    logger -t "$LOG_TAG" "ERROR: Canonical commands directory not found: $COMMANDS_CANONICAL"
else
    # Create local dir if needed
    mkdir -p "$COMMANDS_LOCAL"

    # Check for updates
    if [ ! -f "$COMMANDS_LOCAL_VER" ] || ! diff -q "$COMMANDS_CANONICAL_VER" "$COMMANDS_LOCAL_VER" &>/dev/null; then
        logger -t "$LOG_TAG" "Commands version change detected, syncing..."
        
        # Rsync commands (pure mirror)
        RSYNC_OUT=$(rsync -av --delete --exclude='VERSION' "$COMMANDS_CANONICAL/" "$COMMANDS_LOCAL/" 2>&1)
        RSYNC_EXIT=$?
        
        echo "$RSYNC_OUT" | logger -t "$LOG_TAG"

        if [ $RSYNC_EXIT -eq 0 ]; then
            cp "$COMMANDS_CANONICAL_VER" "$COMMANDS_LOCAL_VER"
            logger -t "$LOG_TAG" "Commands synced successfully"
            echo "SUCCESS: Commands synced successfully"
        else
            logger -t "$LOG_TAG" "ERROR: Commands sync failed"
            echo "ERROR: Commands sync failed" >&2
        fi
    else
        logger -t "$LOG_TAG" "Commands already up to date"
    fi
fi

# ==============================================================================
# SYNC SKILLS
# ==============================================================================

if [ ! -d "$SKILLS_CANONICAL" ]; then
    logger -t "$LOG_TAG" "ERROR: Canonical skills directory not found: $SKILLS_CANONICAL"
else
    # Create local dir if needed
    mkdir -p "$SKILLS_LOCAL"

    # Check for updates
    if [ ! -f "$SKILLS_LOCAL_VER" ] || ! diff -q "$SKILLS_CANONICAL_VER" "$SKILLS_LOCAL_VER" &>/dev/null; then
        logger -t "$LOG_TAG" "Skills version change detected, syncing..."

        # Rsync skills (pure mirror, preserve directory structure, skip find-skills symlink)
        RSYNC_OUT=$(rsync -av --delete --exclude='VERSION' --exclude='find-skills' "$SKILLS_CANONICAL/" "$SKILLS_LOCAL/" 2>&1)
        RSYNC_EXIT=$?

        echo "$RSYNC_OUT" | logger -t "$LOG_TAG"

        if [ $RSYNC_EXIT -eq 0 ]; then
            cp "$SKILLS_CANONICAL_VER" "$SKILLS_LOCAL_VER"
            logger -t "$LOG_TAG" "Skills synced successfully"
            echo "SUCCESS: Skills synced successfully"
        else
            logger -t "$LOG_TAG" "ERROR: Skills sync failed"
            echo "ERROR: Skills sync failed" >&2
        fi
    else
        logger -t "$LOG_TAG" "Skills already up to date"
    fi
fi

# ==============================================================================
# SYNC OPENCODE PLUGIN
# ==============================================================================

if [ ! -d "$OPENCODE_CANONICAL" ]; then
    logger -t "$LOG_TAG" "ERROR: Canonical opencode directory not found: $OPENCODE_CANONICAL"
else
    # Create local plugin dir if needed
    mkdir -p "$OPENCODE_PLUGINS_LOCAL"
    mkdir -p "$OPENCODE_CONFIG_LOCAL"

    # Check for updates (version mismatch)
    if [ ! -f "$OPENCODE_LOCAL_VER" ] || ! diff -q "$OPENCODE_CANONICAL_VER" "$OPENCODE_LOCAL_VER" &>/dev/null; then
        logger -t "$LOG_TAG" "OpenCode plugin version change detected, syncing..."

        # Rsync opencode plugin files (plugin.js and config example)
        RSYNC_OUT=$(rsync -av --delete --exclude='VERSION' "$OPENCODE_CANONICAL/" "$OPENCODE_PLUGINS_LOCAL/" 2>&1)
        RSYNC_EXIT=$?

        echo "$RSYNC_OUT" | logger -t "$LOG_TAG"

        if [ $RSYNC_EXIT -eq 0 ]; then
            cp "$OPENCODE_CANONICAL_VER" "$OPENCODE_LOCAL_VER"
            logger -t "$LOG_TAG" "OpenCode plugin synced successfully"
            echo "SUCCESS: OpenCode plugin synced successfully"
        else
            logger -t "$LOG_TAG" "ERROR: OpenCode plugin sync failed"
            echo "ERROR: OpenCode plugin sync failed" >&2
        fi
    else
        logger -t "$LOG_TAG" "OpenCode plugin already up to date"
    fi

    # Always create config from example if it doesn't exist (handles new/reset nodes)
    if [ ! -f "$OPENCODE_CONFIG_LOCAL/memory-plugin.json" ] && [ -f "$OPENCODE_PLUGINS_LOCAL/memory-plugin.config.example.json" ]; then
        logger -t "$LOG_TAG" "Creating memory-plugin.json from example config..."
        cp "$OPENCODE_PLUGINS_LOCAL/memory-plugin.config.example.json" "$OPENCODE_CONFIG_LOCAL/memory-plugin.json"
        echo "SUCCESS: Created memory-plugin.json from example"
    fi
fi

# MCP Memory Service - Hooks, Commands, and OpenCode Plugin Deployment Workflow

## ⚠️ CRITICAL: Updates Are NOT Automatic

When you update hooks, commands, or OpenCode plugin in the mcp-memory-service repository, they **do NOT automatically propagate** to other nodes. You must manually deploy them to NFS.

## Complete Update Workflow

### Step 1: Update the Repository (on mcp-memory)
```bash
cd ~/mcp-memory-service
git pull origin main
# OR make local changes to claude-hooks/, claude_commands/, or opencode/
```

### Step 2: Deploy to NFS Canonical Location (REQUIRED MANUAL STEP)
```bash
# Run the deployment script (or use deploy.sh which does this automatically)
~/mcp-memory-service/scripts/deployment/deploy-hooks-to-nfs.sh
```

**What this script does**:
- Rsyncs `~/mcp-memory-service/claude-hooks/` → `/mnt/nas/claude/hooks-canonical/`
- Rsyncs `~/mcp-memory-service/claude_commands/` → `/mnt/nas/claude/commands-canonical/`
- Rsyncs `~/mcp-memory-service/opencode/` → `/mnt/nas/claude/opencode-canonical/`
- Creates/updates VERSION files in all locations with:
  - Deployment timestamp
  - Deployer info (user@hostname)
  - Git commit hash and branch
  - File count
- The VERSION file changes trigger sync on all Claude Code nodes

**Note**: You will be prompted to confirm before deployment.

### Step 3: Propagation to All Nodes

**Option A - Automatic (within 1 hour)**:
Every node has a cron job that checks the VERSION file hourly:
```
0 * * * * ~/.local/bin/sync-claude-hooks.sh
```

**Option B - Manual Trigger (immediate)**:

Trigger sync across **all nodes** in claudes group:
```bash
cd ~/homelab-infrastructure/ansible
./sync-all-hooks.sh
```

Or sync **individual nodes**:
```bash
ssh <hostname> "~/.local/bin/sync-claude-hooks.sh"
```

---

## Files and Locations

### On mcp-memory (source)
- **Hooks source**: `~/mcp-memory-service/claude-hooks/`
- **Commands source**: `~/mcp-memory-service/claude_commands/`
- **OpenCode source**: `~/mcp-memory-service/opencode/`
- **Deployment scripts**: `~/mcp-memory-service/scripts/deployment/`

### On NFS (canonical templates - read-only for nodes)
- **Hooks Location**: `/mnt/nas/claude/hooks-canonical/`
- **Commands Location**: `/mnt/nas/claude/commands-canonical/`
- **OpenCode Location**: `/mnt/nas/claude/opencode-canonical/`
- All nodes read from these canonical locations

### On Each Node (local execution copy)
- **Hooks Location**: `~/.claude/hooks/`
- **Commands Location**: `~/.claude/commands/`
- **OpenCode Plugin Location**: `~/.config/opencode/plugins/`
- **OpenCode Config Location**: `~/.config/opencode/memory-plugin.json`
- **Synced from**: NFS canonical when VERSION changes
- **Preserved**: Local `config.json` (user-specific settings)
- **Sync script**: `~/.local/bin/sync-claude-hooks.sh`
- **Sync tracker**: `~/.claude/hooks/.sync-version`, `~/.claude/commands/.sync-version`, `~/.config/opencode/plugins/.sync-version`

---

## OpenCode Plugin Details

The OpenCode Memory Awareness Plugin provides automatic memory context injection for OpenCode sessions:
- Loads relevant memories when an OpenCode session starts
- Injects memory context into `experimental.chat.system.transform`
- Injects condensed memory context into `experimental.session.compacting`

### Plugin Files
- **Plugin binary**: `memory-plugin.js` → deployed to `~/.config/opencode/plugins/`
- **Example config**: `memory-plugin.config.json` → deployed to same directory
- **User config**: `memory-plugin.json` → created from example on first sync (preserved if exists)

### Configuration
The plugin config (`memory-plugin.json`) includes:
- **endpoint**: Memory service HTTP API URL (e.g., `https://memory.timkjr.link`)
- **apiKey**: API key for authentication
- **searchTags**: Tags to filter memories
- **projectQueries**: Queries to run for memory retrieval
- **maxMemoriesPerSession**: Maximum memories to load (default: 8)

### Environment Variable Overrides
If you prefer env vars over config file:
- `OPENCODE_MEMORY_ENDPOINT` or `OPENCODE_MEMORY_URL`
- `OPENCODE_MEMORY_API_KEY`
- `OPENCODE_MEMORY_TIMEOUT_MS`
- `OPENCODE_MEMORY_LOAD_TIMEOUT_MS`

---

## Why This Design?

1. **Prevents accidental deployments** - Work-in-progress changes don't propagate
2. **Gives you control** - Deploy only when you're ready
3. **Allows testing** - Test on mcp-memory before deploying to all nodes
4. **Audit trail** - VERSION file tracks who deployed what and when
5. **Preserves local config** - Each user's config.json and memory-plugin.json are never overwritten

---

## Verification Commands

### Check if files were deployed to NFS
```bash
cat /mnt/nas/claude/hooks-canonical/VERSION
cat /mnt/nas/claude/commands-canonical/VERSION
cat /mnt/nas/claude/opencode-canonical/VERSION
```

### Check if a specific node has synced
```bash
ssh <hostname> "cat ~/.claude/hooks/.sync-version"
ssh <hostname> "cat ~/.claude/commands/.sync-version"
ssh <hostname> "cat ~/.config/opencode/plugins/.sync-version"
# Should match the VERSION files on NFS
```

### Verify OpenCode plugin installation
```bash
ssh <hostname> "ls -la ~/.config/opencode/plugins/memory-plugin.js"
ssh <hostname> "cat ~/.config/opencode/memory-plugin.json"
```

### Compare VERSION across infrastructure
```bash
# NFS canonical
cat /mnt/nas/claude/hooks-canonical/VERSION
cat /mnt/nas/claude/commands-canonical/VERSION
cat /mnt/nas/claude/opencode-canonical/VERSION

# Specific node
ssh development "cat ~/.claude/hooks/.sync-version"
ssh development "cat ~/.claude/commands/.sync-version"
ssh development "cat ~/.config/opencode/plugins/.sync-version"
```

### Force a node to sync immediately
```bash
ssh <hostname> "~/.local/bin/sync-claude-hooks.sh"
```

---

## Typical Workflow Example

```bash
# 1. Make changes to hooks, commands, or OpenCode plugin
cd ~/mcp-memory-service
git pull origin main
# OR edit files in claude-hooks/, claude_commands/, or opencode/

# 2. Test locally on mcp-memory first
claude  # Test your changes work

# 3. Deploy to canonical NFS location when satisfied
~/mcp-memory-service/scripts/deployment/deploy-hooks-to-nfs.sh
# Confirm deployment when prompted

# 4. Wait 1 hour for automatic sync OR trigger immediate sync
cd ~/homelab-infrastructure/ansible
./sync-all-hooks.sh

# 5. Verify deployment on nodes
ssh development "ls -la ~/.config/opencode/plugins/memory-plugin.js"
```

---

## Deployment Architecture

```
mcp-memory-service repo (mcp-memory)
    │
    │ MANUAL STEP: ~/deploy-hooks-to-nfs.sh
    ↓
NFS Canonical 
  - /mnt/nas/claude/hooks-canonical/
  - /mnt/nas/claude/commands-canonical/
  - /mnt/nas/claude/opencode-canonical/
    │
    │ AUTOMATIC (hourly cron) OR MANUAL (./sync-all-hooks.sh)
    ↓
All Claude Nodes
  - ~/.claude/hooks/
  - ~/.claude/commands/
  - ~/.config/opencode/plugins/
```

---

## Important Notes

- **config.json is never overwritten** during sync (preserves user-specific settings)
- **memory-plugin.json is created from example on first sync** (preserved if already exists)
- **Sync is based on VERSION file** - only syncs when VERSION changes
- **rsync required** on mcp-memory (already installed by playbook)
- **Node requirements**: NFS mount at `/mnt/nas/claude` must be accessible
- **Scope**: All nodes in the `claudes` group in ansible/inventory.ini

---

## Troubleshooting

### Hooks not syncing to a node
```bash
# 1. Check NFS mount
ssh <hostname> "mount | grep /mnt/nas"

# 2. Check if VERSION file is accessible
ssh <hostname> "cat /mnt/nas/claude/hooks-canonical/VERSION"

# 3. Run sync manually to see errors
ssh <hostname> "~/.local/bin/sync-claude-hooks.sh"

# 4. Check cron job exists
ssh <hostname> "crontab -l | grep sync-claude-hooks"
```

### OpenCode plugin not syncing
```bash
# 1. Check NFS opencode directory
ssh <hostname> "ls -la /mnt/nas/claude/opencode-canonical/"

# 2. Check local plugin directory
ssh <hostname> "ls -la ~/.config/opencode/plugins/"

# 3. Run sync manually to see errors
ssh <hostname> "~/.local/bin/sync-claude-hooks.sh"
```

### Deploy script not found
```bash
# Script should be in home directory on mcp-memory
ls -la ~/deploy-hooks-to-nfs.sh

# If missing, it's in the ansible directory
scp ansible/deploy-hooks-to-nfs.sh mcp-memory:~/
ssh mcp-memory "chmod +x ~/deploy-hooks-to-nfs.sh"
```

### VERSION file shows old deployment
You forgot to run `~/deploy-hooks-to-nfs.sh` after updating the repo!

---

## Related Files

- **Main deploy script**: `deploy.sh` (calls all deployment scripts)
- **Deployment scripts**: `scripts/deployment/`
  - `update-mcp-memory.sh` - Updates service code and restarts
  - `deploy-hooks-to-nfs.sh` - Deploys hooks/commands/opencode to NFS
  - `update-nodes.sh` - Pushes sync script to all nodes
  - `sync-claude-hooks-refactored.sh` - Syncs from NFS to local node (per-node)
- **Main playbook**: `ansible/claude-code-mcp-memory-deployment.yml`
- **Sync trigger**: `ansible/sync-all-hooks.sh`
- **Inventory**: `ansible/inventory.ini` (claudes group)

---

**Last Updated**: 2026-04-09
**Deployment Architecture Version**: 3.0 (MCP Memory Service with OpenCode Plugin Support)

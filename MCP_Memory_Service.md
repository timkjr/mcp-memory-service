# MCP Memory Service

**Updated:** 2026-04-09

## Service Info

| | Internal | Public |
|--|---------|--------|
| URL | `https://memory.k-lab.lan` | `https://memory.timkjr.link` |
| MCP endpoint | `https://memory.timkjr.link/mcp` | ← use this in config |
| Health | `http://mcp-memory.k-lab.lan:8000/health` | |
| Storage | sqlite-vec | |

## Claude Code Config (`~/.claude.json`)

```json
"memory-service": {
  "url": "https://memory.timkjr.link/mcp",
  "type": "http",
  "headers": {
    "X-API-Key": "<key>"
  }
}
```

> API key is in `~/.claude.json` on docker-vm or in MCP memory.

## OpenCode Plugin

The mcp-memory-service includes an **OpenCode Memory Awareness Plugin** that auto-injects relevant memories into OpenCode sessions.

### What it does
- Loads relevant memories when an OpenCode session starts
- Injects memory context into `experimental.chat.system.transform`
- Injects condensed memory context into `experimental.session.compacting`
- Read-only (no automatic write-back)

### Installation
The plugin is deployed automatically via the deployment scripts:

```
mcp-memory-service repo
    └── opencode/
        ├── memory-plugin.js          # Plugin binary
        └── memory-plugin.config.json  # Default config template
```

Deployed to: `~/.config/opencode/plugins/memory-plugin.js`
Config at: `~/.config/opencode/memory-plugin.json`

### Configuration
The plugin config (`memory-plugin.json`) includes:
```json
{
  "memoryService": {
    "endpoint": "https://memory.timkjr.link",
    "apiKey": "159vNZwaDhRWVLRWYJWnxyOYYhOjpVH6zK/MuPJeexQ=",
    "maxMemoriesPerSession": 8,
    "searchTags": [],
    "projectQueries": [
      "{project} architecture decisions",
      "{project} recent work",
      "{project} open issues"
    ]
  },
  "output": {
    "verbose": true,
    "includeTimestamps": true,
    "maxContentLength": 280
  }
}
```

### Deployment
The plugin syncs to all nodes via the standard sync infrastructure:
- Source: `/mnt/nas/claude/opencode-canonical/`
- Sync script: `~/.local/bin/sync-claude-hooks.sh`
- Auto-syncs hourly via cron
- Creates `memory-plugin.json` from example on first sync (new nodes)

### Manual Sync
```bash
~/.local/bin/sync-claude-hooks.sh
```

### Force Fresh Config
If you need to reset the config to default:
```bash
rm ~/.config/opencode/memory-plugin.json
~/.local/bin/sync-claude-hooks.sh
```

## Known Issue — "needs authentication" dialog

**Symptom:** Claude Code MCP panel shows `memory-service` as `△ needs authentication` with error:
```
SDK auth failed: Protected resource https://memory.timkjr.link does not match 
expected https://memory.k-lab.lan/mcp (or origin)
```

**Cause:** The MCP server advertises its public URL (`memory.timkjr.link`) in its OAuth protected resource metadata (`/.well-known/oauth-protected-resource`). The MCP SDK validates that this matches the URL the client connected to. If the config uses the internal URL (`memory.k-lab.lan`), they don't match → auth dialog loop.

**Fix:** Use the **public URL** in every node's `~/.claude.json`:
```
"url": "https://memory.timkjr.link/mcp"   ✓
"url": "https://memory.k-lab.lan/mcp"     ✗  (triggers auth dialog)
```

Apply on every machine running Claude Code by editing `~/.claude.json` and replacing `memory.k-lab.lan/mcp` with `memory.timkjr.link/mcp`.

## Related

- [[docker-configs Repo]]
- [[Skills and Sync Infrastructure]]
- [[OpenCode Deployment & Audit]]

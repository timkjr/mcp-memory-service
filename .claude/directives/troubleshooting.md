# Troubleshooting

## Common Issues

| Issue | Fix |
|-------|-----|
| Wrong backend showing | `python scripts/validation/diagnose_backend_config.py` |
| Port mismatch (hooks timeout) | Verify same port in `~/.claude/hooks/config.json` and server (default: 8000) |
| Schema validation errors after PR merge | Run `/mcp` in Claude Code to reconnect |
| Database lock errors | Add `journal_mode=WAL` to `MCP_MEMORY_SQLITE_PRAGMAS` in `.env`, restart |
| Tests failing after git pull | `memory restart` or `./scripts/update_and_restart.sh` |
| MCP fails on every session (Windows) | Set `MCP_INIT_TIMEOUT=120` in MCP server env config (issue #474) |
| Cloudflare 401 on MCP server startup (hybrid) | Set `MCP_HYBRID_SYNC_OWNER=http` — MCP server uses SQLite-Vec only |
| Cloudflare 403 / sync not running (IPv6) | Add your IPv6 /64 to the token's IP allowlist, or remove IP filtering |
| Strict stdio client times out during handshake | Set `MCP_INIT_TIMEOUT=5` for lazy loading (issue #561) |
| uv.lock revision downgraded | Local uv 0.7.16 silently downgrades lockfile. `git checkout uv.lock` or upgrade uv |
| Pre-commit hook fails "Package not installed" | Hook uses system Python. Use `PATH=".venv/bin:$PATH" git commit -m "..."` |
| Editable install replaced PyPI version | `uv pip install mcp-memory-service==<version>` to restore |
| Cloudflare 401 after upgrade/restart | Verify `.env` token matches Cloudflare Dashboard — rotation doesn't update `.env` |
| zeroconf DLL / Symantec trojan false positive (Windows) | Set `MCP_MDNS_ENABLED=false` — see `docs/troubleshooting/mdns-symantec-false-positive.md` |

## Heredoc Permission Corruption

**NEVER click "Always allow" on heredoc commands** (`cat << 'EOF' > file`). Claude Code stores the entire command as a Bash permission pattern in `.claude/settings.local.json`, causing parsing errors on next startup.

**Prevention:** Use single "Allow". For report generation, use the `Write` tool instead of shell heredocs.

**Recovery:** Remove the corrupted entries from `.claude/settings.local.json` `permissions.allow` — identifiable by their massive size.

## References

- [docs/troubleshooting/hooks-quick-reference.md](../docs/troubleshooting/hooks-quick-reference.md)
- `python scripts/validation/validate_configuration_complete.py`
- `python scripts/validation/diagnose_backend_config.py`

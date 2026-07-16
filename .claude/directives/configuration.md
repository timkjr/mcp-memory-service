# Configuration Reference

## Key Environment Variables

Full list in `.env.example`. Most important:

```bash
# Storage Backend
MCP_MEMORY_STORAGE_BACKEND=hybrid          # hybrid|cloudflare|sqlite_vec

# Cloudflare (required for hybrid/cloudflare)
CLOUDFLARE_API_TOKEN="your-token"
CLOUDFLARE_ACCOUNT_ID="your-account"
CLOUDFLARE_D1_DATABASE_ID="your-db-id"
CLOUDFLARE_VECTORIZE_INDEX="mcp-memory-index"

# HTTP Server
MCP_HTTP_ENABLED=true
MCP_HTTP_PORT=8000
MCP_API_KEY="your-secure-key"

# CRITICAL for concurrent access (HTTP + MCP server simultaneously)
MCP_MEMORY_SQLITE_PRAGMAS=journal_mode=WAL,busy_timeout=15000,cache_size=20000

# Hybrid mode: let only HTTP server handle Cloudflare sync
MCP_HYBRID_SYNC_OWNER=http

# OAuth (v9.0.6+)
MCP_OAUTH_STORAGE_BACKEND=sqlite
MCP_OAUTH_SQLITE_PATH=./data/oauth.db

# Quality System (v8.45.0+)
MCP_QUALITY_SYSTEM_ENABLED=true

# Consolidation (v8.23.0+)
MCP_CONSOLIDATION_ENABLED=true

# Initialization timeout (increase for slow systems or first-run)
# MCP_INIT_TIMEOUT=120
```

**Configuration precedence:** Environment variables > .env file > Global Claude Config > defaults

After updating `.env`, restart: `memory restart` (preferred) or `./scripts/update_and_restart.sh`.

## CRITICAL: SQLite WAL Mode

`MCP_MEMORY_SQLITE_PRAGMAS` must include `journal_mode=WAL` when both the HTTP server and MCP server run simultaneously. Without WAL, "database is locked" errors occur on concurrent reads/writes.

## Hybrid Mode Best Practice

Set `MCP_HYBRID_SYNC_OWNER=http` so only the HTTP server syncs to Cloudflare. The MCP server (Claude Desktop) then uses SQLite-Vec directly — no Cloudflare credentials needed in `claude_desktop_config.json`. Correct separation of concerns: Claude Desktop = memory access, HTTP server = sync infrastructure.

## External Embedding APIs

Only supported with the `sqlite_vec` backend (not compatible with `hybrid` or `cloudflare`).

```bash
MCP_EXTERNAL_EMBEDDING_URL=http://localhost:8890/v1/embeddings
MCP_EXTERNAL_EMBEDDING_MODEL=nomic-embed-text
MCP_EXTERNAL_EMBEDDING_API_KEY=sk-xxx   # Optional
```

Supported: vLLM, Ollama, TEI, OpenAI, or any OpenAI-compatible `/v1/embeddings` endpoint.

**Important:** Embedding dimensions must match your database schema. Changing dimensions requires re-embedding all memories. See [`docs/deployment/external-embeddings.md`](../docs/deployment/external-embeddings.md).

## Claude Desktop Integration

Recommended `~/.claude/config.json`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "python",
      "args": ["-m", "mcp_memory_service.server"],
      "env": {
        "MCP_MEMORY_STORAGE_BACKEND": "hybrid"
      }
    }
  }
}
```

Alternative: `uv run memory server` or a direct script path.

## Configuration Validation

```bash
python scripts/validation/validate_configuration_complete.py
python scripts/validation/diagnose_backend_config.py
```

# Code Architecture

## High-Level Structure

Principal packages under `src/mcp_memory_service/`:

```
src/mcp_memory_service/
├── server/           # MCP server layer (modular, cache-optimized) + handlers/
├── server_impl.py    # MemoryServer: list_tools()/call_tool() + tool-handler methods
├── mcp_server.py     # MCP server entry wiring
├── tools/            # Declarative tool registry (registry.py) + dispatch table (routing.py)
├── storage/          # Storage backends (Strategy Pattern) + graph.py
├── web/              # FastAPI dashboard + REST API + OAuth + MCP-over-HTTP
├── api/              # Shared API layer (compact types, operations)
├── services/         # Business logic (MemoryService orchestrator)
├── quality/          # AI quality scoring (multi-tier)
├── scoring/          # Scoring / ranking helpers
├── consolidation/    # Dream-inspired memory maintenance
├── reasoning/        # Relationship / inference logic
├── embeddings/       # ONNX embeddings (sentence-transformers)
├── ingestion/        # Document loaders (PDF, DOCX, TXT, JSON, CSV)
├── harvest/          # Memory harvesting
├── sync/             # Hybrid backend sync
├── discovery/        # mDNS / service discovery
├── backup/           # Backup scheduler
├── health/           # Health checks
├── cli/              # `memory` lifecycle CLI (launch/stop/restart/info/logs)
├── config/           # Configuration
├── plugins/          # Plugin hooks
├── models/           # Data models and schemas
├── compat.py         # Compatibility shims + _sanitize_log_value()
└── utils/            # Utilities (health checks, startup orchestrator)
```

## MCP Server Layer (`server/`)

Extracted from a monolithic 5000+ line `server.py` to a modular architecture (v8.59.0). Tool definitions and dispatch are fully declarative as of v11.

- **`server_impl.py`** — Main `MemoryServer` class. `list_tools()` builds from the declarative registry; `call_tool()` dispatches via the routing table.
- **`tools/registry.py`** — `TOOL_REGISTRY`: declarative list of `ToolDef` objects (~28 tools). Each maps 1:1 to a `types.Tool`.
- **`tools/routing.py`** — `ROUTING_TABLE` (name → handler) + `resolve_handler(name)` (lazy import). Replaced the former ~59-branch elif chain.
- **`server/handlers/`** — Modular handlers: `memory.py`, `quality.py`, `consolidation.py`, `graph.py`, `documents.py`, `mistake_notes.py`, `utility.py`. Shape: `async def handle_X(server, arguments) -> List[types.TextContent]`.
- **`cache_manager.py`** — Global singleton caching prevents redundant storage initialization across MCP tool calls.

## Storage Backend Architecture (`storage/`)

Strategy Pattern with 3 implementations sharing the `BaseStorage` interface:

| Backend | File | Performance | Use Case |
|---------|------|-------------|----------|
| **SQLite-Vec** | `sqlite_vec.py` | 5ms reads | Development, single-user |
| **Cloudflare** | `cloudflare.py` | Network-dependent | Cloud-only, edge deployment |
| **Hybrid** | `hybrid.py` | 5ms local + cloud sync | **Production (RECOMMENDED)** |

- Hybrid: Local SQLite-Vec for reads, background Cloudflare sync
- Graph storage in `graph.py` (v8.51.0) — 30x query performance
- Embeddings: ONNX model (sentence-transformers/all-MiniLM-L6-v2)

## Web Layer (`web/`)

FastAPI REST API and dashboard:
- **`app.py`** — Main FastAPI application
- **`api/mcp.py`** — MCP-over-HTTP transport (thin shim; tool surface inherited from `MemoryServer`)
- **`oauth/`** — OAuth 2.1 Dynamic Client Registration (v7.0.0+)
- **`sse.py`** — Server-Sent Events for real-time updates
- **`static/`** — Single-page dashboard

Tools that read caller-supplied filesystem paths are filtered from the remote transport by `local_only_tools()` (confused-deputy guard).

## Quality System (`quality/`)

Multi-tier AI quality scoring (v8.45.0+):

| Tier | Provider | Latency | Cost | Use Case |
|------|----------|---------|------|----------|
| 1 | Local ONNX | 80-150ms | $0 | DEFAULT |
| 2 | Groq/Llama 3 | 500-800ms | $0.0015 | Fallback |
| 3 | Gemini 1.5 Flash | 1-2s | $0.01 | High-accuracy |

Key files: `onnx_ranker.py`, `ai_evaluator.py`, `async_scorer.py`, `implicit_signals.py`

## Consolidation System (`consolidation/`)

Dream-inspired memory maintenance (v8.23.0+). Runs via HTTP API (90% token reduction vs MCP tools) with APScheduler.

- `decay.py` — Exponential decay scoring
- `association_discovery.py` — Find semantic relationships
- `relationship_inference.py` — Auto-classify relationship types (v9.3.0+)
- `compression.py` — Semantic clustering and merging
- `forgetting.py` — Quality-based archival (High: 365d, Medium: 180d, Low: 30-90d)
- `scheduler.py` — daily/weekly/monthly scheduling

## Document Ingestion (`ingestion/`)

Registry pattern: `registry.py` selects loader by file extension. Loaders: `pdf_loader.py`, `text_loader.py`, `json_loader.py`, `csv_loader.py`. Optional `semtools_loader.py` (LlamaParse). Chunker: 1000 chars, 200 overlap.

## Key Design Patterns

1. **Strategy Pattern** — Storage backends, health checks, quality analytics
2. **Orchestrator Pattern** — Startup orchestrator, consolidation scheduler
3. **Processor Pattern** — Document ingestion, file processing
4. **Registry Pattern** — Document loaders, storage factory, declarative tool registry
5. **Singleton Pattern** — Global caching (storage, service instances)

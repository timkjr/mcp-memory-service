# Handoff — Two-Phase Query API handler skeletons (#56 / #61)

**Date:** 2026-06-11 · **Owner of this slice:** doobidoo (skeletons) · **Picked up by Claudio (filhocf):** phase-1 aggregation
**Status:** not started · **Blocked on v11?** No — runs in parallel.

## Division of labor (agreed in #56, 2026-06-11 19:18)

- **This handoff (us):** scaffold the two new read-only MCP tools end to end — tool registration, dispatch wiring, request parsing, `entity_id` normalization, response **shapes**, and thin calls into existing graph storage. Aggregation logic is **stubbed at a clear boundary**.
- **Claudio:** fills the phase-1 aggregation inside the boundary — entity discovery → extractive (LLM-free) summary → top-chunks ranking against existing relevance.

## Locked contract (from #61)

Two **read-only** tools (`annotations={'readOnlyHint': True}` — required so the HTTP `/mcp` layer treats them as read-scope, GHSA-2r68-g678-7qr3):

- `memory_explore(query, max_entities=10, chunks_per_entity=3, tags?, min_score=0.0)` → knowledge map.
  Per entity: `{entity_id, name, entity_type, summary, relation_count, top_chunks[]}`. **LLM-free** (extractive summary from top-N chunks + graph degree).
- `memory_detail(entity_id, limit=50, include_related=true, max_hops=1)` → full ranked `chunks[]` (with `composite_score` + `score_components` once #55 lands, else `relevance`) + `related_entities[]`.

### `entity_id` normalization (agreed: NFKD + hash fallback) — implement once, canonical

```python
import unicodedata, re, hashlib

def normalize_entity_id(name: str) -> str:
    nfkd = unicodedata.normalize('NFKD', name)
    ascii_ish = ''.join(c for c in nfkd if not unicodedata.combining(c))
    slug = re.sub(r'[^a-z0-9]+', '-', ascii_ish.lower().strip()).strip('-')
    if not slug:  # CJK/Cyrillic/Greek/Arabic — no ASCII decomposition
        return 'e-' + hashlib.sha1(name.encode('utf-8')).hexdigest()[:8]
    return slug
```
Must be deterministic and consolidation-stable. Collision disambiguation (two distinct surface forms → same slug) appends the same short hash suffix. Put it in `src/mcp_memory_service/storage/graph.py` (or a small `utils` module) so both handlers and the graph layer share one definition. `normalize_entity_id` does **not** exist yet — this is net-new.

## Where the code goes (verified anchors, 2026-06-11)

| Step | File | Exact change |
|------|------|--------------|
| 1. Tool defs | `src/mcp_memory_service/tools/registry.py` | Add two `ToolDef(...)` entries to `TOOL_REGISTRY` (class at L15; copy the `memory_list` read-only entry at L303-374 as the shape, incl. `annotations={'readOnlyHint': True}` at L374). |
| 2. Dispatch | `src/mcp_memory_service/tools/routing.py` | Add to `_PRIMARY` (L21): `"memory_explore": _handler("graph", "handle_memory_explore"),` and `"memory_detail": _handler("graph", "handle_memory_detail"),`. (`_handler(module, func)` helper at L15; lazy-imported in `resolve_handler` L105.) |
| 3. Handlers | `src/mcp_memory_service/server/handlers/graph.py` | Implement `async def handle_memory_explore(server, arguments: dict) -> List[types.TextContent]` and `handle_memory_detail(...)`. Mirror the existing signature/shape of `handle_find_connected_memories` (L301) / `handle_memory_graph` (L75). |
| 4. Tests | `tests/server/test_handlers.py` | Add shape/contract tests (registration present, readOnlyHint set, response keys match contract, `normalize_entity_id` cases incl. CJK→hash). |

`call_tool` (server_impl.py L1556) resolves via `routing.resolve_handler(name)` then calls `await handler(self, arguments)` for module handlers — so steps 1+2+3 are all that's needed to make the tools live. No `server_impl.py` edit required (no elif chain anymore).

## Graph storage methods available to call (storage/graph.py, verified)

- `list_entities(limit=50)` L744 → `[{entity_id/name/entity_type/...}]`
- `get_entity_profile(entity_name)` L783 → profile dict (use for `memory_detail`)
- `find_memories_by_entity(entity_name, limit=20)` L763 → `[memory_hash]`
- `find_connected(...)` L243 / `common_neighbors(...)` L894 → for `related_entities[]` / `max_hops`
- `get_relationship_types(memory_hash)` L328 → `{type: count}` for `relation_count`
- Memory scoring today is flat `relevance` (memory.py `handle_retrieve_memory` L491; `composite_score = result.relevance_score`). Use `relevance` now; swap to `composite_score`/`score_components` when #55 lands.

## The boundary — what we stub vs. what Claudio fills

**Skeleton (us) returns the correct shape with minimal/placeholder aggregation:**

```python
async def handle_memory_explore(server, arguments: dict) -> List[types.TextContent]:
    query = arguments.get("query", "")
    max_entities = arguments.get("max_entities", 10)
    chunks_per_entity = arguments.get("chunks_per_entity", 3)
    tags = arguments.get("tags")
    min_score = arguments.get("min_score", 0.0)
    store = arguments.get("store", "default")  # #62 — already threaded in storage layer

    # 1. candidate retrieval (real) — semantic search scoped by tags/store
    candidates = await server.storage.retrieve(query, n_results=..., tags=tags, store=store)

    # 2. group candidates by linked entity (real-ish: use graph links)
    #    -> {entity_name: [chunk results]}

    # ---- TODO(filhocf): phase-1 aggregation begins here ----
    #   - entity discovery / dedup via normalize_entity_id
    #   - extractive (LLM-free) summary from top-N chunks
    #   - top_chunks ranking against existing relevance
    #   For now: summary="" (or first chunk excerpt), top_chunks=first N, relation_count via get_relationship_types
    # ---- TODO(filhocf): phase-1 aggregation ends here ----

    knowledge_map = [
        {
            "entity_id": normalize_entity_id(name),
            "name": name,
            "entity_type": ...,
            "summary": "",            # filled by aggregation
            "relation_count": ...,
            "top_chunks": [...][:chunks_per_entity],
        }
        for name in grouped
    ][:max_entities]
    return [types.TextContent(type="text", text=json.dumps({"entities": knowledge_map}))]
```

`memory_detail` similarly: parse `entity_id`, resolve to entity via `get_entity_profile` / `find_memories_by_entity`, return ranked `chunks[]` (relevance now) + `related_entities[]` (via `find_connected`/`common_neighbors`, gated on `include_related`/`max_hops`). The ranking refinement is also Claudio's aggregation slice.

## Acceptance for the skeleton PR

- Both tools registered, `readOnlyHint=True`, resolvable via `routing`, callable end to end returning the contract's JSON keys (even if `summary`/ranking are placeholder).
- `normalize_entity_id` canonical + unit-tested (ASCII slug, accented→ascii, CJK→`e-<hash8>`, collision→hash suffix).
- `store` param accepted and passed through (composes with #62).
- `pre_pr_check.sh` green; tests in `tests/server/test_handlers.py`.
- PR description marks the `TODO(filhocf)` boundary so Claudio's follow-up is a clean fill, not a rewrite.

## Sequencing note

Independent of v11.0.0 (target ~2026-06-22). Can land on `main` anytime. Will compose with #55 (composite scoring) and #54 (NER) when those land — both are forward-compatible with this shape (`relevance`→`composite_score`; richer entities from NER).

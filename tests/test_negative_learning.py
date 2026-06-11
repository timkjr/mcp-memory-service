"""
Tests for P4: Negative Learning (RFC Self-Service Memory Intelligence).

Extends mistake_note with confidence scoring, frustration decay,
and automatic AVOID rule promotion.
"""

import json
import pytest
from mcp_memory_service.server import MemoryServer
from mcp_memory_service.storage.mixins.embeddings import SENTENCE_TRANSFORMERS_AVAILABLE


@pytest.mark.skipif(
    not SENTENCE_TRANSFORMERS_AVAILABLE,
    reason="Requires real embedding model for semantic similarity"
)
class TestNegativeLearning:
    """P4: Confidence + frustration on mistake notes."""

    @pytest.mark.asyncio
    async def test_mistake_note_has_confidence(self):
        """New mistake notes should have initial confidence in metadata."""
        server = MemoryServer()
        result = await server.handle_mistake_note_add({
            "error_pattern": "SQL query without LIMIT on large table",
            "context_signature": "PostgreSQL, table > 1M rows",
            "incorrect_action": "SELECT * FROM big_table",
            "correct_action": "SELECT * FROM big_table LIMIT 100",
        })
        data = json.loads(result[0].text) if hasattr(result[0], 'text') else result
        assert data.get("status") in ("created", "updated")
        # Verify metadata has confidence
        # Search for the note and check metadata
        search = await server.handle_mistake_note_search({
            "query": "SQL query without LIMIT"
        })
        search_data = json.loads(search[0].text)
        notes = search_data.get("notes", search_data.get("memories", []))
        assert len(notes) > 0
        meta = notes[0].get("metadata", {})
        if isinstance(meta, str):
            meta = json.loads(meta)
        assert "confidence" in meta
        assert 0.0 <= meta["confidence"] <= 1.0

    @pytest.mark.asyncio
    async def test_mistake_note_has_frustration_score(self):
        """Mistake notes should track frustration_score."""
        server = MemoryServer()
        await server.handle_mistake_note_add({
            "error_pattern": "Forgot to run tests before push",
            "context_signature": "git push without test",
            "incorrect_action": "git push directly",
            "correct_action": "Run tests first, then push",
        })
        search = await server.handle_mistake_note_search({
            "query": "Forgot to run tests before push"
        })
        search_data = json.loads(search[0].text)
        notes = search_data.get("notes", search_data.get("memories", []))
        assert len(notes) > 0
        meta = notes[0].get("metadata", {})
        if isinstance(meta, str):
            meta = json.loads(meta)
        assert "frustration_score" in meta

    @pytest.mark.asyncio
    async def test_frustration_increments_on_repeated_error(self):
        """Frustration score should increase when same error recurs."""
        server = MemoryServer()
        pattern = "Permission denied on deploy target directory"

        # First occurrence
        await server.handle_mistake_note_add({
            "error_pattern": pattern,
            "context_signature": "deploy to /var/www",
            "incorrect_action": "deploy without chown",
            "correct_action": "chown first, then deploy",
        })
        # Second occurrence (should increment)
        await server.handle_mistake_note_add({
            "error_pattern": pattern,
            "context_signature": "deploy to /var/www",
            "incorrect_action": "deploy without chown",
            "correct_action": "chown first, then deploy",
        })

        search = await server.handle_mistake_note_search({"query": pattern})
        search_data = json.loads(search[0].text)
        notes = search_data.get("notes", search_data.get("memories", []))
        meta = notes[0].get("metadata", {})
        if isinstance(meta, str):
            meta = json.loads(meta)
        assert meta.get("frustration_score", 0) >= 2.0

    @pytest.mark.asyncio
    async def test_avoid_rule_flag_when_threshold_exceeded(self):
        """When frustration exceeds threshold, note gets is_avoid_rule=True."""
        server = MemoryServer()
        pattern = "Using strReplace on shared MEMORY.md file"

        # Simulate many failures (threshold default = 5)
        for _ in range(6):
            await server.handle_mistake_note_add({
                "error_pattern": pattern,
                "context_signature": "multi-session shared file",
                "incorrect_action": "strReplace on MEMORY.md",
                "correct_action": "Use insert (append) instead",
            })

        search = await server.handle_mistake_note_search({"query": pattern})
        search_data = json.loads(search[0].text)
        notes = search_data.get("notes", search_data.get("memories", []))
        meta = notes[0].get("metadata", {})
        if isinstance(meta, str):
            meta = json.loads(meta)
        assert meta.get("is_avoid_rule") is True

    @pytest.mark.asyncio
    async def test_confidence_increases_with_errors(self):
        """Confidence in the mistake pattern should increase with repeated errors."""
        server = MemoryServer()
        pattern = "Posting to GitHub without showing draft first"

        await server.handle_mistake_note_add({
            "error_pattern": pattern,
            "context_signature": "external communication",
            "incorrect_action": "Post directly",
            "correct_action": "Show draft, wait for OK, then post",
        })
        search1 = await server.handle_mistake_note_search({"query": pattern})
        data1 = json.loads(search1[0].text)
        notes1 = data1.get("notes", data1.get("memories", []))
        meta1 = notes1[0].get("metadata", {})
        if isinstance(meta1, str):
            meta1 = json.loads(meta1)
        conf1 = meta1.get("confidence", 0.5)

        # Second error
        await server.handle_mistake_note_add({
            "error_pattern": pattern,
            "context_signature": "external communication",
            "incorrect_action": "Post directly",
            "correct_action": "Show draft, wait for OK, then post",
        })
        search2 = await server.handle_mistake_note_search({"query": pattern})
        data2 = json.loads(search2[0].text)
        notes2 = data2.get("notes", data2.get("memories", []))
        meta2 = notes2[0].get("metadata", {})
        if isinstance(meta2, str):
            meta2 = json.loads(meta2)
        conf2 = meta2.get("confidence", 0.5)

        assert conf2 > conf1

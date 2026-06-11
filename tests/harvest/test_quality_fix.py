"""Tests for harvest quality improvements (§0): sentence extraction, role filter, confidence gate."""

import pytest
from mcp_memory_service.harvest.extractor import PatternExtractor
from mcp_memory_service.harvest.parser import ParsedMessage


@pytest.fixture
def extractor():
    return PatternExtractor(locale="en,pt_BR")


class TestSentenceExtraction:
    """Extractor should extract the relevant sentence(s) around the match, not the full message."""

    def test_extracts_sentence_around_match_not_full_message(self, extractor):
        """When pattern matches mid-message, extract context around match, not first 500 chars."""
        long_message = (
            "Let me explain the full context of this system. "
            "We have three microservices communicating via gRPC. "
            "The authentication layer uses JWT tokens with RS256. "
            "The root cause was a race condition in the connection pool. "
            "This caused all downstream queries to timeout. "
            "We fixed it by adding a semaphore with max 10 connections. "
            "The deployment went smoothly after that change."
        )
        msg = ParsedMessage(role="assistant", text=long_message)
        candidates = extractor.extract(msg)
        bug_candidates = [c for c in candidates if c.memory_type == "bug"]
        assert len(bug_candidates) >= 1
        # Should contain the match sentence
        assert "race condition" in bug_candidates[0].content
        # Should NOT contain unrelated intro
        assert "Let me explain the full context" not in bug_candidates[0].content

    def test_includes_context_sentence_before_and_after(self, extractor):
        """Extracted content includes ±1 sentence of context around the match."""
        message = (
            "First unrelated sentence about setup. "
            "The database was configured with default settings. "
            "The root cause was missing WAL pragma in SQLite config. "
            "Adding PRAGMA journal_mode=WAL fixed the issue. "
            "Last unrelated sentence about deployment."
        )
        msg = ParsedMessage(role="assistant", text=message)
        candidates = extractor.extract(msg)
        bug_candidates = [c for c in candidates if c.memory_type == "bug"]
        assert len(bug_candidates) >= 1
        content = bug_candidates[0].content
        # Should have the match + some context
        assert "WAL pragma" in content
        # Should have nearby context
        assert "WAL fixed" in content or "database" in content
        # Should NOT have distant unrelated text
        assert "First unrelated sentence" not in content

    def test_max_content_length_respected(self, extractor):
        """Extracted content respects max length even with long surrounding sentences."""
        # Build a message where the match is surrounded by very long sentences
        long_prefix = "A" * 200 + ". "
        match_sentence = "The root cause was a null pointer in the auth middleware. "
        long_suffix = "B" * 200 + "."
        message = long_prefix + match_sentence + long_suffix
        msg = ParsedMessage(role="assistant", text=message)
        candidates = extractor.extract(msg)
        for c in candidates:
            assert len(c.content) <= 500  # Should not exceed max

    def test_pt_br_sentence_extraction(self, extractor):
        """Sentence extraction works with Portuguese text."""
        message = (
            "Vou explicar o contexto completo do problema que encontramos. "
            "O sistema tem 3 componentes principais rodando em containers. "
            "O problema era que o handler bloqueava o event loop inteiro. "
            "Isso causava timeout em todos os clientes conectados. "
            "A solução foi usar asyncio.create_task para rodar em background."
        )
        msg = ParsedMessage(role="assistant", text=message)
        candidates = extractor.extract(msg)
        bug_candidates = [c for c in candidates if c.memory_type == "bug"]
        assert len(bug_candidates) >= 1
        assert "handler bloqueava" in bug_candidates[0].content
        assert "Vou explicar o contexto completo" not in bug_candidates[0].content


class TestRoleFilter:
    """Extractor should filter user messages by default, except conventions."""

    def test_skips_user_messages_by_default(self, extractor):
        """User messages are skipped when role_filter=True."""
        msg = ParsedMessage(role="user", text="the problem is that it doesn't work, please fix it for me")
        candidates = extractor.extract(msg, role_filter=True)
        assert candidates == []

    def test_user_convention_is_extracted(self, extractor):
        """User messages with convention patterns ARE extracted even with role_filter."""
        msg = ParsedMessage(role="user", text="Convention: NEVER use SSH for git, always HTTPS with token")
        candidates = extractor.extract(msg, role_filter=True)
        assert len(candidates) >= 1
        assert candidates[0].memory_type == "convention"

    def test_user_explicit_rule_is_extracted(self, extractor):
        """User stating explicit rules should be captured."""
        msg = ParsedMessage(role="user", text="regra: NUNCA fazer push direto na main. Sempre usar branch + PR.")
        candidates = extractor.extract(msg, role_filter=True)
        assert len(candidates) >= 1
        assert candidates[0].memory_type == "convention"

    def test_assistant_messages_always_processed(self, extractor):
        """Assistant messages are always processed regardless of role_filter."""
        msg = ParsedMessage(role="assistant", text="The root cause was a missing index on the users table.")
        candidates_filtered = extractor.extract(msg, role_filter=True)
        candidates_unfiltered = extractor.extract(msg, role_filter=False)
        assert len(candidates_filtered) == len(candidates_unfiltered)
        assert len(candidates_filtered) >= 1

    def test_role_filter_off_processes_all(self, extractor):
        """With role_filter=False, user messages are processed normally (backward compat)."""
        msg = ParsedMessage(role="user", text="I learned that ONNX models need warmup on first inference.")
        candidates = extractor.extract(msg, role_filter=False, min_confidence=0.6)
        assert len(candidates) >= 1


class TestConfidenceGate:
    """Candidates below min_confidence threshold should be discarded."""

    def test_low_confidence_filtered(self, extractor):
        """Context-type patterns (confidence 0.6) are filtered at gate 0.75."""
        msg = ParsedMessage(role="assistant", text="The current state of the project is that we have 3 modules done.")
        candidates = extractor.extract(msg, min_confidence=0.75)
        # "current state" pattern has confidence 0.6 — should be filtered
        context_candidates = [c for c in candidates if c.memory_type == "context"]
        assert context_candidates == []

    def test_high_confidence_passes(self, extractor):
        """High-confidence patterns (0.75+) pass the gate."""
        msg = ParsedMessage(role="assistant", text="Convention: always run tests before pushing to main branch.")
        candidates = extractor.extract(msg, min_confidence=0.75)
        assert len(candidates) >= 1

    def test_default_min_confidence_is_075(self, extractor):
        """Default min_confidence should be 0.75 (not the old 0.6)."""
        msg = ParsedMessage(role="assistant", text="next steps are to deploy and monitor")
        # "next steps" has confidence 0.6 — should be filtered by default
        candidates = extractor.extract(msg)
        context_candidates = [c for c in candidates if c.memory_type == "context"]
        assert context_candidates == []

    def test_explicit_low_gate_allows_more(self, extractor):
        """Explicitly setting min_confidence=0.5 allows lower-confidence candidates."""
        msg = ParsedMessage(role="assistant", text="The current state is that we're blocked on the API review.")
        candidates = extractor.extract(msg, min_confidence=0.5)
        assert len(candidates) >= 1

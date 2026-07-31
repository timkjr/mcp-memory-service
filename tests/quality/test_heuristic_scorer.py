"""Tests for the heuristic content quality scorer."""

from mcp_memory_service.quality.heuristic_scorer import score_content


def test_critical_prefixed_note_is_not_hard_rejected():
    """CRITICAL: is Tim's own note-emphasis prefix, not a log level — must
    not hit the garbage hard-reject path (score 0.05)."""
    content = (
        "CRITICAL: Tim NEVER uses Anthropic API keys in OpenCode or any "
        "third-party tool — only the Claude subscription via claude.ai/code."
    )
    score = score_content(content)
    assert score > 0.5


def test_actual_log_lines_still_hard_rejected():
    """WARNING/ERROR/INFO/DEBUG at line-start are still real log-level
    indicators and should still be rejected."""
    content = "WARNING: connection refused\nERROR: retrying in 5s\nINFO: giving up"
    score = score_content(content)
    assert score == 0.05


def test_critical_mid_sentence_is_not_penalized():
    """CRITICAL appearing mid-sentence (not a line-start log marker) should
    never have triggered the garbage pattern in the first place."""
    content = (
        "This is a critical fix for the docker-vm backup pipeline that was "
        "silently failing for over two weeks before anyone noticed the gap."
    )
    score = score_content(content)
    assert score > 0.5

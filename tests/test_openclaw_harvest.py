"""Tests for OpenClaw trajectory parser support (#19)."""

import json
import tempfile
from pathlib import Path

import pytest

from mcp_memory_service.harvest.parser import TranscriptParser


@pytest.fixture
def parser():
    return TranscriptParser()


@pytest.fixture
def openclaw_session(tmp_path):
    """Create a sample OpenClaw trajectory JSONL file."""
    lines = [
        {"traceSchema": "openclaw-trajectory", "type": "session.started", "ts": "2026-06-01T10:00:00Z", "data": {}},
        {"traceSchema": "openclaw-trajectory", "type": "prompt.submitted", "ts": "2026-06-01T10:00:01Z", "data": {"prompt": "Analise o bug no parser de sessões"}},
        {"traceSchema": "openclaw-trajectory", "type": "context.compiled", "ts": "2026-06-01T10:00:02Z", "data": {"tokens": 1500}},
        {"traceSchema": "openclaw-trajectory", "type": "model.completed", "ts": "2026-06-01T10:00:05Z", "data": {"assistantTexts": ["O bug está na função _parse_line que não detecta o formato OpenClaw.", "A causa raiz é que o traceSchema não é verificado."]}},
        {"traceSchema": "openclaw-trajectory", "type": "prompt.submitted", "ts": "2026-06-01T10:01:00Z", "data": {"prompt": "Corrija o bug"}},
        {"traceSchema": "openclaw-trajectory", "type": "model.completed", "ts": "2026-06-01T10:01:05Z", "data": {"assistantTexts": ["Corrigido. Adicionei detecção via traceSchema field."]}},
        {"traceSchema": "openclaw-trajectory", "type": "session.ended", "ts": "2026-06-01T10:02:00Z", "data": {}},
    ]
    filepath = tmp_path / "test-session.trajectory.jsonl"
    filepath.write_text("\n".join(json.dumps(l) for l in lines))
    return filepath


class TestOpenClawParser:
    """OpenClaw trajectory format parsing."""

    def test_detects_openclaw_format(self, parser, openclaw_session):
        """Should auto-detect openclaw-trajectory format."""
        messages = parser.parse_file(openclaw_session)
        assert len(messages) > 0

    def test_extracts_user_messages(self, parser, openclaw_session):
        """prompt.submitted → user messages."""
        messages = parser.parse_file(openclaw_session)
        user_msgs = [m for m in messages if m.role == "user"]
        assert len(user_msgs) == 2
        assert "bug no parser" in user_msgs[0].text

    def test_extracts_assistant_messages(self, parser, openclaw_session):
        """model.completed → assistant messages (texts joined)."""
        messages = parser.parse_file(openclaw_session)
        assistant_msgs = [m for m in messages if m.role == "assistant"]
        assert len(assistant_msgs) == 2
        # Multiple assistantTexts should be joined
        assert "causa raiz" in assistant_msgs[0].text
        assert "traceSchema" in assistant_msgs[0].text

    def test_skips_non_message_events(self, parser, openclaw_session):
        """session.started, context.compiled, session.ended → skipped."""
        messages = parser.parse_file(openclaw_session)
        # 2 user + 2 assistant = 4 messages (not 7 lines)
        assert len(messages) == 4

    def test_preserves_timestamps(self, parser, openclaw_session):
        """Timestamps from 'ts' field should be preserved."""
        messages = parser.parse_file(openclaw_session)
        assert messages[0].timestamp == "2026-06-01T10:00:01Z"

    def test_find_sessions_includes_trajectory_files(self, parser, tmp_path):
        """find_sessions should discover .trajectory.jsonl files."""
        (tmp_path / "session1.jsonl").write_text('{"kind":"Prompt"}\n')
        (tmp_path / "session2.trajectory.jsonl").write_text('{"traceSchema":"openclaw-trajectory"}\n')
        sessions = parser.find_sessions(tmp_path, count=10)
        names = [s.name for s in sessions]
        assert "session2.trajectory.jsonl" in names

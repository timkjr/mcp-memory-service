"""Tests for bootstrap formatter plugin system (TDD)."""

import pytest
import os


class TestFormatterRegistry:
    """Plugin registry deve existir e resolver formatters."""

    def test_module_exists(self):
        """bootstrap.formatter module deve existir."""
        from mcp_memory_service.bootstrap import formatter
        assert hasattr(formatter, "get_formatter")

    def test_get_claude_formatter(self):
        """get_formatter('claude') retorna ClaudeFormatter."""
        from mcp_memory_service.bootstrap.formatter import get_formatter
        f = get_formatter("claude")
        assert f.name == "claude"

    def test_get_kiro_formatter(self):
        """get_formatter('kiro') retorna KiroFormatter."""
        from mcp_memory_service.bootstrap.formatter import get_formatter
        f = get_formatter("kiro")
        assert f.name == "kiro"

    def test_unknown_returns_claude(self):
        """get_formatter('unknown') retorna ClaudeFormatter (default)."""
        from mcp_memory_service.bootstrap.formatter import get_formatter
        f = get_formatter("unknown")
        assert f.name == "claude"


class TestClaudeFormatter:
    """Claude formatter — formato upstream padrão."""

    def test_has_sections(self):
        """Output tem ## Avoidances, ## Preferences, ## Conventions."""
        from mcp_memory_service.bootstrap.formatter import get_formatter
        f = get_formatter("claude")
        result = f.format(
            avoidances=["- ⚠️ Never do X"],
            preferences=["- Prefer Y"],
            conventions=["- Always Z"],
            meta={"generated_at": "2026-05-31"},
        )
        assert "## Avoidances" in result
        assert "## Preferences" in result
        assert "## Conventions" in result
        assert "Never do X" in result

    def test_empty_sections_omitted(self):
        """Seções vazias não aparecem no output."""
        from mcp_memory_service.bootstrap.formatter import get_formatter
        f = get_formatter("claude")
        result = f.format(avoidances=[], preferences=[], conventions=["- Rule"], meta={})
        assert "## Avoidances" not in result
        assert "## Conventions" in result


class TestKiroFormatter:
    """Kiro formatter — enforcement language."""

    def test_avoidances_use_nunca(self):
        """Avoidances usam '❌ NUNCA:' prefix."""
        from mcp_memory_service.bootstrap.formatter import get_formatter
        f = get_formatter("kiro")
        result = f.format(
            avoidances=["- ⚠️ Never strReplace on MEMORY.md"],
            preferences=[],
            conventions=[],
            meta={},
        )
        assert "❌" in result
        assert "MEMORY.md" in result

    def test_conventions_use_sempre(self):
        """Conventions usam '✅ SEMPRE:' prefix."""
        from mcp_memory_service.bootstrap.formatter import get_formatter
        f = get_formatter("kiro")
        result = f.format(
            avoidances=[],
            preferences=[],
            conventions=["- Use EnvironmentFile= for services"],
            meta={},
        )
        assert "✅" in result
        assert "EnvironmentFile" in result


class TestDispatchByAgentId:
    """Dispatch por agent_id via env var."""

    def test_env_override_for_kiro(self):
        """MCP_BOOTSTRAP_FORMATTER_kiro=kiro seleciona KiroFormatter."""
        os.environ["MCP_BOOTSTRAP_FORMATTER_kiro"] = "kiro"
        from mcp_memory_service.bootstrap.formatter import get_formatter_for_agent
        f = get_formatter_for_agent("kiro")
        assert f.name == "kiro"
        del os.environ["MCP_BOOTSTRAP_FORMATTER_kiro"]

    def test_default_for_unknown_agent(self):
        """Agente sem override usa MCP_BOOTSTRAP_FORMATTER (default claude)."""
        os.environ.pop("MCP_BOOTSTRAP_FORMATTER_random", None)
        os.environ["MCP_BOOTSTRAP_FORMATTER"] = "claude"
        from mcp_memory_service.bootstrap.formatter import get_formatter_for_agent
        f = get_formatter_for_agent("random")
        assert f.name == "claude"

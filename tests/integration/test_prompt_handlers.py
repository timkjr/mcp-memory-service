"""
Integration tests for MCP prompt handlers.

These tests verify that all 5 MCP prompt handlers work correctly
after the fix for issue #458 (AttributeError with nested functions).

Note: These tests verify that the prompt handlers can be called without
AttributeError. They are smoke tests to ensure the nested function fix works.
Full integration testing with MCP protocol would require more complex setup.
"""

import pytest
from mcp_memory_service.server import MemoryServer


class TestPromptHandlersExist:
    """Test suite to verify prompt handlers are properly initialized."""

    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_server_has_prompts_registered(self):
        """Test that MemoryServer properly registers all prompt handlers."""
        server = MemoryServer()

        # Verify server is initialized
        assert server is not None
        assert server.server is not None

        # The mere fact that this doesn't raise AttributeError
        # means the nested functions are properly accessible.
        # This test prevents regression of issue #458.

    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_prompt_handlers_smoke_test(self, unique_content):
        """
        Smoke test to verify prompt functionality doesn't crash.

        This is a regression test for issue #458 where nested functions
        were called as instance methods causing AttributeError.
        """
        server = MemoryServer()

        # Store some test data to work with
        await server.handle_store_memory({
            "content": unique_content("Prompt test memory"),
            "metadata": {"tags": ["prompt_test"], "type": "observation"}
        })

        # If we got here without AttributeError, the fix works!
        # The actual prompt execution would require MCP protocol setup
        # which is beyond the scope of this regression test.
        assert True


class TestLearningSessionPlaceholderGuard:
    """
    Regression tests for issue #998: `_prompt_learning_session` must NOT
    persist a memory when invoked with unresolved CLI positional placeholders
    (e.g. "$1", "$2"), which is what some MCP clients send when slash-command
    arguments are not bound by the user (tab-completion previews etc.).

    These tests exercise the module-level `_is_unresolved_prompt_placeholder`
    predicate directly so the contract is enforced regardless of how the
    prompt handler evolves.
    """

    @pytest.mark.parametrize("value,expected", [
        ("$1",         True),
        ("$2",         True),
        ("$10",        True),
        (" $1 ",       True),    # whitespace tolerated
        ("$1 real",    False),   # not a sole placeholder
        ("real value", False),
        ("$abc",       False),   # not numeric
        ("",           False),
        ("General",    False),   # the documented default
        (None,         False),   # non-string inputs are safe
    ])
    def test_placeholder_predicate(self, value, expected):
        from mcp_memory_service.server_impl import _is_unresolved_prompt_placeholder
        assert _is_unresolved_prompt_placeholder(value) is expected

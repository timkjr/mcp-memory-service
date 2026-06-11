"""Configuration package for MCP Memory Service.

Split from monolithic config.py for maintainability.
All symbols are re-exported here for backward compatibility:
    from mcp_memory_service.config import X  # still works
"""

from .base import *  # noqa: F401,F403
from .storage import *  # noqa: F401,F403
from .embedding import *  # noqa: F401,F403
from .transport import *  # noqa: F401,F403
from .oauth import *  # noqa: F401,F403
from .oauth import _load_pem_from_env  # noqa: F401 — tests import this directly
from .documents import *  # noqa: F401,F403
from .backup import *  # noqa: F401,F403
from .consolidation import *  # noqa: F401,F403
from .quality import *  # noqa: F401,F403
from .search import *  # noqa: F401,F403
from .graph import *  # noqa: F401,F403
from .ontology import *  # noqa: F401,F403
from .validation import *  # noqa: F401,F403

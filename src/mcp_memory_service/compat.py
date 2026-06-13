# Copyright 2024 Heinrich Krupp
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Logging sanitization helper.

Through v10 this module also hosted the deprecated tool-name compatibility
layer (``DEPRECATED_TOOLS`` + transform helpers). V11 removed the legacy
aliases (Issue #53, Phase 2), so only the log-injection guard remains.

``_sanitize_log_value`` is imported widely across the codebase to keep
user-provided values from forging log lines (CodeQL py/log-injection,
GHSA-84hp-mqvj-3p8h); it is intentionally kept in this stable location.
"""


def _sanitize_log_value(value: object) -> str:
    """Sanitize a user-provided value for safe inclusion in log messages."""
    return str(value).replace("\n", "\\n").replace("\r", "\\r").replace("\x1b", "\\x1b")

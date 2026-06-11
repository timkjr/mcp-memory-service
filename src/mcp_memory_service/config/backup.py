"""Backup and integrity check configuration."""
import os
import logging

from .base import safe_get_int_env, safe_get_bool_env

logger = logging.getLogger(__name__)

# =============================================================================
# Automatic Backup Configuration
# =============================================================================

BACKUP_ENABLED = safe_get_bool_env('MCP_BACKUP_ENABLED', True)
BACKUP_INTERVAL = os.getenv('MCP_BACKUP_INTERVAL', 'daily').lower()  # 'hourly', 'daily', 'weekly'
BACKUP_RETENTION = safe_get_int_env('MCP_BACKUP_RETENTION', 7, min_value=1, max_value=365)  # days
BACKUP_MAX_COUNT = safe_get_int_env('MCP_BACKUP_MAX_COUNT', 10, min_value=1, max_value=100)  # max backups to keep

# Validate backup interval
if BACKUP_INTERVAL not in ['hourly', 'daily', 'weekly']:
    logger.warning(f"Invalid backup interval: {BACKUP_INTERVAL}, falling back to 'daily'")
    BACKUP_INTERVAL = 'daily'

logger.info(f"Backup configuration: enabled={BACKUP_ENABLED}, interval={BACKUP_INTERVAL}, retention={BACKUP_RETENTION} days")

# =============================================================================
# End Automatic Backup Configuration
# =============================================================================

# =============================================================================
# Database Integrity Health Monitoring
# =============================================================================
# Periodic PRAGMA integrity_check to detect SQLite corruption early.
# SQLite WAL mode is crash-resistant but not SIGKILL-resistant — process kills
# during writes can corrupt the WAL/SHM files or main database. Periodic
# integrity monitoring catches corruption within minutes rather than waiting
# for the next user operation to fail and lose data.
#
# Performance: integrity_check takes ~3.5ms on a typical database.
# At the default 30-minute interval, this adds 0.0002% overhead.

INTEGRITY_CHECK_ENABLED = safe_get_bool_env('MCP_MEMORY_INTEGRITY_CHECK_ENABLED', True)
INTEGRITY_CHECK_INTERVAL = safe_get_int_env('MCP_MEMORY_INTEGRITY_CHECK_INTERVAL', 1800, min_value=60, max_value=86400)  # seconds, default 30 min

logger.info(f"Integrity monitoring: enabled={INTEGRITY_CHECK_ENABLED}, interval={INTEGRITY_CHECK_INTERVAL}s")

# =============================================================================
# End Database Integrity Health Monitoring
# =============================================================================

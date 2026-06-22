---
name: memory
description: Query and manage the memory service. Shows status, searches memories, and reports health. Subcommands - search <query>, health, mode <profile>.
---

This command is handled by the memory-plugin.js OpenCode plugin, which returns real-time data directly.

Usage:
- `/memory` — show session status (memories loaded, captures, last action)
- `/memory search <query>` — search memories for a topic
- `/memory health` — check memory service health and backend
- `/memory mode <profile>` — switch memory mode (speed_focused, balanced, memory_aware)

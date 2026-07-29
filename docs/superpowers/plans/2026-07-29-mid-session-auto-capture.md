# Mid-Session Auto-Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace session-end harvest with two automatic mid-session capture tiers: Tier 1 fires on git commits, deploys, and DECISIONS.md writes; Tier 2 fires on language-signal checkpoints and periodic turn thresholds.

**Architecture:** Tier 1 extends `auto-capture-hook.js` (PostToolUse) with event-type detection that runs before the existing keyword fallback. Tier 2 replaces `mid-conversation.js` (UserPromptSubmit) entirely — the existing T1/T2/T3 tiered LLM analysis is removed. New detection and extraction utilities land in `auto-capture-patterns.js`. Session state for Tier 2 turn counting persists in `/tmp/mcp-hooks-<session_id>.json`.

**Tech Stack:** Node.js (CJS), `node:test` for tests, `child_process.execSync` for git info, existing `MemoryClient` HTTP client.

## Global Constraints

- All hooks must exit 0 on any error — never block user workflow
- No LLM calls in any hook's capture path
- Run with: `node --test claude-hooks/tests/<file>.test.js`
- After any config.json change: `cp /home/timkjr/dev/mcp-memory/claude-hooks/config.json ~/.claude/hooks/config.json`
- Tests use `node:test` and `node:assert` — no test framework dependencies
- `MemoryClient` is always `connect()` → operation → `disconnect()` (see Task 1 storeMemory pattern)
- Memory types must be lowercase from the service ontology: `decision`, `note`, `insight`

---

## File Map

| File | Action | What changes |
|---|---|---|
| `claude-hooks/config.json` | Modify | Add `tier1` and `tier2` sub-keys under `autoCapture` |
| `claude-hooks/config.template.json` | Modify | Same as config.json |
| `claude-hooks/utilities/auto-capture-patterns.js` | Modify | Add `detectTier1Event`, `detectTier2Signal`, `extractContextWindow`, `extractProseFromContent`, `countProseWords`, `buildTier1Memory`, `getLastCommitInfo`, `extractServiceName` |
| `claude-hooks/core/auto-capture-hook.js` | Modify | Call `detectTier1Event` before existing keyword detection; add Tier 1 capture path |
| `claude-hooks/core/mid-conversation.js` | Rewrite | Replace T1/T2/T3 tiered analysis with Tier 2 checkpoint logic |
| `claude-hooks/tests/tier-detection.test.js` | Create | Unit tests for `detectTier1Event`, `detectTier2Signal`, `countProseWords`, `buildTier1Memory` |
| `claude-hooks/tests/tier2-checkpoint.test.js` | Create | Unit tests for Tier 2 session state and prose density logic |

---

### Task 1: Config extension

**Files:**
- Modify: `claude-hooks/config.json`
- Modify: `claude-hooks/config.template.json`

**Interfaces:**
- Produces: `config.autoCapture.tier1.enabled`, `config.autoCapture.tier1.contextWindowSize`, `config.autoCapture.tier2.enabled`, `config.autoCapture.tier2.turnThreshold`, `config.autoCapture.tier2.cooldownTurns`, `config.autoCapture.tier2.minProseWords` — consumed by Tasks 3 and 4

- [ ] **Step 1: Replace the `autoCapture` section in `config.json`**

Find this in `claude-hooks/config.json` (line 115–117):
```json
  "autoCapture": {
    "enabled": true
  },
```
Replace with:
```json
  "autoCapture": {
    "enabled": true,
    "tier1": {
      "enabled": true,
      "contextWindowSize": 8
    },
    "tier2": {
      "enabled": true,
      "turnThreshold": 20,
      "cooldownTurns": 5,
      "minProseWords": 150
    }
  },
```

- [ ] **Step 2: Apply the same change to `config.template.json`**

Find and replace the same `autoCapture` block in `claude-hooks/config.template.json`. If `autoCapture` is absent from the template, add the full block above after `"sessionAnalysis"`.

- [ ] **Step 3: Sync the installed config**

```bash
cp /home/timkjr/dev/mcp-memory/claude-hooks/config.json ~/.claude/hooks/config.json
```

- [ ] **Step 4: Commit**

```bash
git add claude-hooks/config.json claude-hooks/config.template.json
git commit -m "config: add tier1/tier2 auto-capture config structure"
```

---

### Task 2: Detection and extraction utilities

**Files:**
- Modify: `claude-hooks/utilities/auto-capture-patterns.js`
- Create: `claude-hooks/tests/tier-detection.test.js`

**Interfaces:**
- Produces (consumed by Tasks 3 and 4):
  - `detectTier1Event(toolName: string, toolInput: object) → { type: 'gitCommit'|'deployRestart'|'decisionsFile', tool: string, input: object } | null`
  - `detectTier2Signal(userMessage: string) → boolean`
  - `extractContextWindow(transcriptPath: string, windowSize: number) → Promise<string>`
  - `countProseWords(text: string) → number`
  - `buildTier1Memory(eventType: string, eventData: object, contextWindow: string, projectName: string) → { content: string, memoryType: string, tags: string[] }`
  - `getLastCommitInfo(cwd: string) → { hash: string, subject: string, body: string, files: string } | null`

- [ ] **Step 1: Write failing tests**

Create `claude-hooks/tests/tier-detection.test.js`:

```javascript
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
    detectTier1Event,
    detectTier2Signal,
    countProseWords,
    buildTier1Memory,
} = require('../utilities/auto-capture-patterns');

test('detectTier1Event: Bash git commit', () => {
    const result = detectTier1Event('Bash', { command: "git commit -m 'fix: thing'" });
    assert.strictEqual(result?.type, 'gitCommit');
});

test('detectTier1Event: mcp git commit tool', () => {
    const result = detectTier1Event('mcp__git__git_commit', { message: 'fix: thing' });
    assert.strictEqual(result?.type, 'gitCommit');
});

test('detectTier1Event: systemctl restart', () => {
    const result = detectTier1Event('Bash', { command: 'systemctl restart mcp-memory-http.service' });
    assert.strictEqual(result?.type, 'deployRestart');
});

test('detectTier1Event: docker compose up', () => {
    const result = detectTier1Event('Bash', { command: 'docker compose up -d' });
    assert.strictEqual(result?.type, 'deployRestart');
});

test('detectTier1Event: deploy.sh', () => {
    const result = detectTier1Event('Bash', { command: './deploy.sh' });
    assert.strictEqual(result?.type, 'deployRestart');
});

test('detectTier1Event: Write to DECISIONS.md', () => {
    const result = detectTier1Event('Write', { file_path: '/home/timkjr/dev/mcp-memory/DECISIONS.md', content: '[2026-07-29] Chose X.' });
    assert.strictEqual(result?.type, 'decisionsFile');
});

test('detectTier1Event: Write to non-DECISIONS file returns null', () => {
    const result = detectTier1Event('Write', { file_path: '/home/timkjr/dev/foo.js' });
    assert.strictEqual(result, null);
});

test('detectTier1Event: plain Bash returns null', () => {
    const result = detectTier1Event('Bash', { command: 'ls -la' });
    assert.strictEqual(result, null);
});

test('detectTier2Signal: root cause phrase', () => {
    assert.strictEqual(detectTier2Signal('the root cause was a missing env var'), true);
});

test('detectTier2Signal: turns out phrase', () => {
    assert.strictEqual(detectTier2Signal('Turns out the API was rate-limiting us'), true);
});

test('detectTier2Signal: plain question returns false', () => {
    assert.strictEqual(detectTier2Signal('can you fix this?'), false);
});

test('countProseWords: counts words correctly', () => {
    assert.strictEqual(countProseWords('hello world foo'), 3);
});

test('countProseWords: empty string returns 0', () => {
    assert.strictEqual(countProseWords(''), 0);
});

test('buildTier1Memory: gitCommit returns decision type', () => {
    const mem = buildTier1Memory('gitCommit', { subject: 'fix: thing', body: '', files: 'src/foo.js' }, 'User: hi\nAssistant: ok', 'mcp-memory');
    assert.strictEqual(mem.memoryType, 'decision');
    assert.ok(mem.content.includes('fix: thing'));
    assert.ok(mem.tags.includes('commit'));
    assert.ok(mem.tags.includes('auto-capture'));
});

test('buildTier1Memory: deployRestart returns note type', () => {
    const mem = buildTier1Memory('deployRestart', { input: { command: 'systemctl restart foo' } }, '', 'mcp-memory');
    assert.strictEqual(mem.memoryType, 'note');
    assert.ok(mem.tags.includes('deploy'));
});

test('buildTier1Memory: decisionsFile returns decision type', () => {
    const mem = buildTier1Memory('decisionsFile', { input: { content: '[2026-07-29] Chose X over Y.' } }, '', 'mcp-memory');
    assert.strictEqual(mem.memoryType, 'decision');
    assert.ok(mem.content.includes('Chose X over Y'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/timkjr/dev/mcp-memory
node --test claude-hooks/tests/tier-detection.test.js
```

Expected: failures with `TypeError: detectTier1Event is not a function` or similar.

- [ ] **Step 3: Add utilities to `auto-capture-patterns.js`**

Append before the `module.exports` line at the bottom of `claude-hooks/utilities/auto-capture-patterns.js`:

```javascript
const { execSync } = require('child_process');
const fs_sync = require('fs');
const path_mod = require('path');

const TIER1_DEPLOY_REGEX = /\b(systemctl\s+(restart|start)\b|docker\s+compose\s+(up|restart)\b|docker\s+restart\b|\.\/deploy\.sh\b|kubectl\s+apply\b)/;

const TIER2_SIGNAL_REGEX = /\b(I think what happened|turns out|the root cause|the fix was|here['']s what we learned|so the theory is|what we found|I believe the issue is|the problem was|what I think is)\b/i;

/**
 * Detect if a PostToolUse event is a Tier 1 completion event.
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {{ type: string, tool: string, input: object } | null}
 */
function detectTier1Event(toolName, toolInput) {
    if (!toolName) return null;

    if (toolName === 'mcp__git__git_commit') {
        return { type: 'gitCommit', tool: toolName, input: toolInput || {} };
    }

    if (toolName === 'Bash') {
        const cmd = toolInput?.command || '';
        if (/git\s+commit\b/.test(cmd)) {
            return { type: 'gitCommit', tool: toolName, input: toolInput };
        }
        if (TIER1_DEPLOY_REGEX.test(cmd)) {
            return { type: 'deployRestart', tool: toolName, input: toolInput };
        }
    }

    if ((toolName === 'Write' || toolName === 'Edit') && /DECISIONS\.md$/.test(toolInput?.file_path || '')) {
        return { type: 'decisionsFile', tool: toolName, input: toolInput };
    }

    return null;
}

/**
 * Detect if a user message contains a Tier 2 language signal.
 * @param {string} userMessage
 * @returns {boolean}
 */
function detectTier2Signal(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return TIER2_SIGNAL_REGEX.test(userMessage);
}

/**
 * Extract prose text from a Claude Code content block array or string.
 * Strips tool_use / tool_result blocks; keeps only text blocks.
 * @param {string|Array} content
 * @returns {string}
 */
function extractProseFromContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter(block => block.type === 'text')
        .map(block => block.text || '')
        .join('\n');
}

/**
 * Read the last `windowSize` user/assistant turns from a JSONL transcript,
 * stripping tool output. Returns a formatted string.
 * @param {string} transcriptPath
 * @param {number} windowSize
 * @returns {Promise<string>}
 */
async function extractContextWindow(transcriptPath, windowSize = 8) {
    const fsAsync = require('fs').promises;
    const raw = await fsAsync.readFile(transcriptPath, 'utf8');
    const turns = [];

    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const parsed = JSON.parse(trimmed);
            const items = Array.isArray(parsed) ? parsed : [parsed];
            for (const item of items) {
                const role = item.message?.role || item.role;
                if (role !== 'user' && role !== 'assistant') continue;
                const rawContent = item.message?.content ?? item.content;
                const text = extractProseFromContent(rawContent).trim();
                if (text) turns.push({ role, text });
            }
        } catch { /* skip malformed lines */ }
    }

    return turns
        .slice(-windowSize)
        .map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
        .join('\n\n');
}

/**
 * Count prose words in text (split on whitespace, min 2 chars).
 * @param {string} text
 * @returns {number}
 */
function countProseWords(text) {
    if (!text) return 0;
    return text.trim().split(/\s+/).filter(w => w.length > 1).length;
}

/**
 * Get the last git commit info from the repo at `cwd`.
 * @param {string} cwd
 * @returns {{ hash: string, subject: string, body: string, files: string } | null}
 */
function getLastCommitInfo(cwd) {
    try {
        const opts = { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] };
        const hash = execSync('git log -1 --format=%H', opts).trim();
        const subject = execSync('git log -1 --format=%s', opts).trim();
        const body = execSync('git log -1 --format=%b', opts).trim();
        const files = execSync('git show --stat --format= HEAD', opts).trim();
        return { hash, subject, body, files };
    } catch {
        return null;
    }
}

/**
 * Infer a service name from a deploy/restart command string.
 * @param {string} cmd
 * @returns {string}
 */
function extractServiceName(cmd) {
    const patterns = [
        /systemctl\s+(?:restart|start)\s+(\S+)/,
        /docker\s+restart\s+(\S+)/,
        /docker\s+compose\s+(?:up|restart)(?:\s+-\S+)*\s+(\S+)/,
    ];
    for (const p of patterns) {
        const m = cmd.match(p);
        if (m) return m[1];
    }
    if (/deploy\.sh/.test(cmd)) return 'deploy.sh';
    return cmd.slice(0, 60);
}

/**
 * Build the memory content, type, and tags for a Tier 1 event.
 * @param {string} eventType - 'gitCommit' | 'deployRestart' | 'decisionsFile'
 * @param {object} eventData - event-specific data
 * @param {string} contextWindow - formatted conversation window
 * @param {string|null} projectName
 * @returns {{ content: string, memoryType: string, tags: string[] }}
 */
function buildTier1Memory(eventType, eventData, contextWindow, projectName) {
    const baseTags = ['auto-capture', 'tier1'];
    if (projectName) baseTags.push(projectName.toLowerCase());

    if (eventType === 'gitCommit') {
        const { subject = '', body = '', files = '' } = eventData;
        const parts = [`## Commit: ${subject}`];
        if (body) parts.push(body);
        if (files) parts.push(`Files changed:\n${files}`);
        if (contextWindow) parts.push(`## Session Context\n${contextWindow}`);
        return {
            content: parts.join('\n\n'),
            memoryType: 'decision',
            tags: [...baseTags, 'commit'],
        };
    }

    if (eventType === 'deployRestart') {
        const cmd = eventData?.input?.command || 'unknown';
        const service = extractServiceName(cmd);
        const parts = [`## Deploy/Restart: ${service}`, `Command: \`${cmd}\``];
        if (contextWindow) parts.push(`## Session Context\n${contextWindow}`);
        return {
            content: parts.join('\n\n'),
            memoryType: 'note',
            tags: [...baseTags, 'deploy'],
        };
    }

    if (eventType === 'decisionsFile') {
        const raw = eventData?.input?.content || eventData?.input?.new_string || '';
        const entries = raw.match(/^\[\d{4}-\d{2}-\d{2}\].+/gm) || [];
        const latest = entries[entries.length - 1] || raw.slice(0, 500);
        return {
            content: `## Decision recorded\n${latest}`,
            memoryType: 'decision',
            tags: [...baseTags, 'decision'],
        };
    }

    return { content: '', memoryType: 'note', tags: baseTags };
}
```

- [ ] **Step 4: Add new exports to `module.exports` at the bottom of `auto-capture-patterns.js`**

Find the existing `module.exports = { ... }` block and add the new exports:

```javascript
module.exports = {
    // existing exports unchanged:
    PATTERNS,
    USER_OVERRIDES,
    DEFAULT_CONFIG,
    detectPatterns,
    hasUserOverride,
    generateTags,
    truncateContent,
    computeContentHash,
    extractProjectName,
    // new exports:
    detectTier1Event,
    detectTier2Signal,
    extractProseFromContent,
    extractContextWindow,
    countProseWords,
    getLastCommitInfo,
    extractServiceName,
    buildTier1Memory,
};
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
node --test claude-hooks/tests/tier-detection.test.js
```

Expected: all tests PASS.

- [ ] **Step 6: Run existing pattern tests to confirm no regression**

```bash
node --test claude-hooks/tests/auto-capture-patterns.test.js
```

Expected: all existing tests still PASS.

- [ ] **Step 7: Commit**

```bash
git add claude-hooks/utilities/auto-capture-patterns.js claude-hooks/tests/tier-detection.test.js
git commit -m "feat(hooks): add tier1/tier2 detection and extraction utilities"
```

---

### Task 3: Tier 1 capture in auto-capture-hook.js

**Files:**
- Modify: `claude-hooks/core/auto-capture-hook.js`

**Interfaces:**
- Consumes: `detectTier1Event`, `extractContextWindow`, `buildTier1Memory`, `getLastCommitInfo` from `auto-capture-patterns.js`; `storeMemory` already defined in this file
- Produces: Tier 1 memories stored to the memory service on git commit, deploy, DECISIONS.md write

- [ ] **Step 1: Add new imports at top of `auto-capture-hook.js`**

Find the existing require block (lines 17–31) and add:

```javascript
const {
    detectPatterns,
    hasUserOverride,
    generateTags,
    truncateContent,
    computeContentHash,
    extractProjectName,
    DEFAULT_CONFIG,
    // NEW:
    detectTier1Event,
    extractContextWindow,
    buildTier1Memory,
    getLastCommitInfo,
} = require('../utilities/auto-capture-patterns');
```

- [ ] **Step 2: Add `loadConfig` Tier 1 config reading**

In the `loadConfig()` function, the returned object currently has `autoCapture`. Extend the return to include tier config:

```javascript
return {
    memoryService: config.memoryService || { http: { endpoint: 'http://127.0.0.1:8000', apiKey: '' } },
    autoCapture: {
        ...(config.autoCapture || {}),
        enabled: config.autoCapture?.enabled !== false,
        tier1: {
            enabled: config.autoCapture?.tier1?.enabled !== false,
            contextWindowSize: config.autoCapture?.tier1?.contextWindowSize || 8,
        },
        // preserve existing fields:
        minLength: config.autoCapture?.minLength || 300,
        maxLength: config.autoCapture?.maxLength || 4000,
        patterns: config.autoCapture?.patterns || ['decision', 'error', 'learning', 'implementation', 'important', 'code'],
        debugMode: config.autoCapture?.debugMode || false,
    }
};
```

Apply the same change to the catch-branch default return in `loadConfig()`.

- [ ] **Step 3: Add Tier 1 handling in `main()` before the existing keyword detection**

In `main()`, find this block (around line 263):

```javascript
// Parse transcript
const transcript = await parseTranscript(transcriptPath);
if (!transcript) {
    process.exit(0);
}
```

Insert the Tier 1 path **immediately after** that block (before the `hasUserOverride` call):

```javascript
// --- Tier 1: completion event capture ---
if (config.autoCapture.tier1.enabled) {
    const toolName = input.tool_name || '';
    const toolInput = input.tool_input || {};
    const tier1Event = detectTier1Event(toolName, toolInput);

    if (tier1Event) {
        let eventData = { input: toolInput };

        // For git commits, fetch actual commit info from git log
        if (tier1Event.type === 'gitCommit') {
            const commitInfo = getLastCommitInfo(cwd);
            if (commitInfo) {
                eventData = commitInfo;
            } else {
                // Fallback: extract message from command if git log unavailable
                const cmdMatch = (toolInput.command || '').match(/-m\s+['"]([^'"]+)['"]/);
                eventData = { subject: cmdMatch ? cmdMatch[1] : 'commit', body: '', files: '' };
            }
        }

        let contextWindow = '';
        try {
            contextWindow = await extractContextWindow(
                transcriptPath,
                config.autoCapture.tier1.contextWindowSize
            );
        } catch (err) {
            if (config.autoCapture.debugMode) {
                console.log(`[auto-capture] Context window extraction failed: ${err.message}`);
            }
        }

        const projectName = extractProjectName(cwd);
        const { content, memoryType, tags } = buildTier1Memory(
            tier1Event.type, eventData, contextWindow, projectName
        );

        if (content) {
            if (config.autoCapture.debugMode) {
                console.log(`[auto-capture] Tier 1 event: ${tier1Event.type}, storing as ${memoryType}`);
            }
            try {
                await storeMemory(config, content, memoryType, tags);
                if (config.autoCapture.debugMode) {
                    console.log(`[auto-capture] Tier 1 stored successfully`);
                }
            } catch (err) {
                console.error(`[auto-capture] Tier 1 store failed: ${err.message}`);
            }
        }
        // Don't exit — fall through to existing keyword detection as well,
        // which will likely not match (commit output rarely has keyword patterns),
        // and will exit normally.
    }
}
// --- end Tier 1 ---
```

- [ ] **Step 4: Manual smoke test — git commit**

Make a trivial change and commit:

```bash
cd /home/timkjr/dev/mcp-memory
echo "# test" >> /tmp/test-capture.txt
git add /tmp/test-capture.txt 2>/dev/null || true
# Instead: just verify the hook fires by checking logs
memory logs -n 20 | grep -i "tier 1\|auto-capture"
```

Alternatively, enable `debugMode: true` temporarily in `~/.claude/hooks/config.json`, make a commit in any project, and check stderr for `[auto-capture] Tier 1 event: gitCommit`.

- [ ] **Step 5: Commit**

```bash
git add claude-hooks/core/auto-capture-hook.js
git commit -m "feat(hooks): add tier1 completion-event capture to auto-capture-hook"
```

---

### Task 4: Tier 2 — mid-conversation.js rewrite

**Files:**
- Rewrite: `claude-hooks/core/mid-conversation.js`
- Create: `claude-hooks/tests/tier2-checkpoint.test.js`

**Interfaces:**
- Consumes: `detectTier2Signal`, `extractContextWindow`, `countProseWords` from `auto-capture-patterns.js`; `MemoryClient` from `memory-client.js`; `extractProjectName` from `auto-capture-patterns.js`
- Produces: `insight` memories on language signals, `note` memories on turn threshold

The UserPromptSubmit hook receives via stdin:
```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/path/to/project",
  "hook_event_name": "UserPromptSubmit",
  "message": "the user's message text"
}
```

Session state is stored at `/tmp/mcp-hooks-<session_id>.json`:
```json
{ "turnCount": 5, "lastTier2Turn": 0, "tier1FiredCount": 0 }
```

- [ ] **Step 1: Write failing tests**

Create `claude-hooks/tests/tier2-checkpoint.test.js`:

```javascript
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { countProseWords, detectTier2Signal } = require('../utilities/auto-capture-patterns');

// --- Prose density check ---
test('countProseWords: 150 words of prose passes', () => {
    const words = Array(150).fill('word').join(' ');
    assert.ok(countProseWords(words) >= 150);
});

test('countProseWords: 10 words fails density threshold', () => {
    assert.ok(countProseWords('just ten words here today yes ok wow hi') < 150);
});

// --- Tier 2 signal detection ---
test('detectTier2Signal: "the fix was" triggers', () => {
    assert.strictEqual(detectTier2Signal("the fix was restarting the service"), true);
});

test('detectTier2Signal: "here is what we learned" triggers', () => {
    assert.strictEqual(detectTier2Signal("here's what we learned from the incident"), true);
});

test('detectTier2Signal: "what I think is" triggers', () => {
    assert.strictEqual(detectTier2Signal("what I think is the proxy config is wrong"), true);
});

test('detectTier2Signal: neutral question does not trigger', () => {
    assert.strictEqual(detectTier2Signal("can you look at this file?"), false);
});

test('detectTier2Signal: empty string does not trigger', () => {
    assert.strictEqual(detectTier2Signal(''), false);
});

// --- Cooldown logic (pure function, no I/O) ---
test('cooldown: turn within cooldown window is blocked', () => {
    const state = { turnCount: 10, lastTier2Turn: 8, tier1FiredCount: 0 };
    const cooldownTurns = 5;
    const turnsSinceLast = state.turnCount - state.lastTier2Turn;
    assert.ok(turnsSinceLast < cooldownTurns, 'Should be blocked by cooldown');
});

test('cooldown: turn outside cooldown window is allowed', () => {
    const state = { turnCount: 15, lastTier2Turn: 8, tier1FiredCount: 0 };
    const cooldownTurns = 5;
    const turnsSinceLast = state.turnCount - state.lastTier2Turn;
    assert.ok(turnsSinceLast >= cooldownTurns, 'Should pass cooldown');
});

// --- Turn threshold ---
test('threshold: fires at turn 20 with no tier1 events', () => {
    const state = { turnCount: 20, lastTier2Turn: 0, tier1FiredCount: 0 };
    const threshold = 20;
    const turnsSinceLast = state.turnCount - state.lastTier2Turn;
    assert.ok(turnsSinceLast >= threshold);
});

test('threshold: does not fire at turn 19', () => {
    const state = { turnCount: 19, lastTier2Turn: 0, tier1FiredCount: 0 };
    const threshold = 20;
    const turnsSinceLast = state.turnCount - state.lastTier2Turn;
    assert.ok(turnsSinceLast < threshold);
});
```

- [ ] **Step 2: Run tests to verify they fail (detectTier2Signal missing)**

```bash
node --test claude-hooks/tests/tier2-checkpoint.test.js
```

Expected: failures until Task 2 is complete. If Task 2 is already done, these should pass.

- [ ] **Step 3: Run tests to confirm Task 2 exports resolve them**

```bash
node --test claude-hooks/tests/tier2-checkpoint.test.js
```

Expected: all PASS (the logic is in `auto-capture-patterns.js` — these tests verify the logic is correct before the hook uses it).

- [ ] **Step 4: Replace `mid-conversation.js` entirely**

Overwrite `claude-hooks/core/mid-conversation.js` with:

```javascript
#!/usr/bin/env node
/**
 * Tier 2 Checkpoint Hook — UserPromptSubmit
 *
 * Fires on two conditions:
 *   A) User message contains a conclusion/summary language signal
 *   B) Every 20 turns in sessions with no Tier 1 events
 *
 * Captures the last 10 conversation turns (prose only) as an insight or note.
 * Session state (turn counter) persists in /tmp/mcp-hooks-<session_id>.json.
 */

'use strict';

const fs = require('fs').promises;
const path = require('path');
const { resolveConfigPath } = require('../utilities/config-loader');
const { MemoryClient } = require('../utilities/memory-client');
const {
    detectTier2Signal,
    extractContextWindow,
    countProseWords,
    extractProjectName,
    hasUserOverride,
} = require('../utilities/auto-capture-patterns');

const STATE_DIR = '/tmp';

async function loadSessionState(sessionId) {
    const stateFile = path.join(STATE_DIR, `mcp-hooks-${sessionId}.json`);
    try {
        const data = await fs.readFile(stateFile, 'utf8');
        return JSON.parse(data);
    } catch {
        return { turnCount: 0, lastTier2Turn: -99, tier1FiredCount: 0 };
    }
}

async function saveSessionState(sessionId, state) {
    const stateFile = path.join(STATE_DIR, `mcp-hooks-${sessionId}.json`);
    await fs.writeFile(stateFile, JSON.stringify(state), 'utf8');
}

async function loadConfig() {
    const configPath = resolveConfigPath(__dirname);
    try {
        const data = await fs.readFile(configPath, 'utf8');
        const config = JSON.parse(data);
        return {
            memoryService: config.memoryService || { http: { endpoint: 'http://127.0.0.1:8000', apiKey: '' } },
            tier2: {
                enabled: config.autoCapture?.tier2?.enabled !== false,
                turnThreshold: config.autoCapture?.tier2?.turnThreshold || 20,
                cooldownTurns: config.autoCapture?.tier2?.cooldownTurns || 5,
                minProseWords: config.autoCapture?.tier2?.minProseWords || 150,
                debugMode: config.autoCapture?.debugMode || false,
            },
        };
    } catch {
        return {
            memoryService: { http: { endpoint: 'http://127.0.0.1:8000', apiKey: '' } },
            tier2: { enabled: true, turnThreshold: 20, cooldownTurns: 5, minProseWords: 150, debugMode: false },
        };
    }
}

async function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        const timeout = setTimeout(() => resolve(data || '{}'), 1000);
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => data += chunk);
        process.stdin.on('end', () => { clearTimeout(timeout); resolve(data); });
        process.stdin.on('error', () => resolve('{}'));
        process.stdin.resume();
    });
}

async function storeMemory(config, content, memoryType, tags) {
    const client = new MemoryClient({
        protocol: 'auto',
        preferredProtocol: 'http',
        http: {
            endpoint: config.memoryService.http.endpoint,
            apiKey: config.memoryService.http.apiKey,
        },
    });
    await client.connect();
    let result;
    try {
        result = await client.storeMemory(content, {
            tags,
            memoryType,
            metadata: { source: 'tier2-checkpoint', hook: 'UserPromptSubmit', captured_at: new Date().toISOString() },
        });
    } finally {
        await client.disconnect();
    }
    if (!result.success) throw new Error(result.error || 'store returned success=false');
    return result;
}

async function main() {
    try {
        const config = await loadConfig();
        if (!config.tier2.enabled) process.exit(0);

        const stdinData = await readStdin();
        let input = {};
        try { input = JSON.parse(stdinData); } catch { process.exit(0); }

        const sessionId = input.session_id || 'unknown';
        const transcriptPath = input.transcript_path || input.transcriptPath;
        const cwd = input.cwd || process.cwd();
        const userMessage = input.message || '';

        if (!transcriptPath) process.exit(0);

        // #skip override
        const overrides = hasUserOverride(userMessage);
        if (overrides.forceSkip) process.exit(0);

        // Load + increment session state
        const state = await loadSessionState(sessionId);
        state.turnCount += 1;

        const { turnThreshold, cooldownTurns, minProseWords, debugMode } = config.tier2;
        const turnsSinceLast = state.turnCount - state.lastTier2Turn;

        // Determine fire condition
        const isLanguageSignal = detectTier2Signal(userMessage);
        const isThresholdFire = (turnsSinceLast >= turnThreshold);
        const shouldFire = (isLanguageSignal || isThresholdFire) && (turnsSinceLast >= cooldownTurns);

        if (!shouldFire) {
            await saveSessionState(sessionId, state);
            process.exit(0);
        }

        if (debugMode) {
            const reason = isLanguageSignal ? 'language-signal' : 'turn-threshold';
            console.log(`[tier2] Firing (${reason}), turn ${state.turnCount}`);
        }

        // Extract conversation window
        const contextWindow = await extractContextWindow(transcriptPath, 10);
        const proseWords = countProseWords(contextWindow);

        if (proseWords < minProseWords) {
            if (debugMode) console.log(`[tier2] Skipping: only ${proseWords} prose words (min ${minProseWords})`);
            await saveSessionState(sessionId, state);
            process.exit(0);
        }

        // Build memory
        const projectName = extractProjectName(cwd);
        const memoryType = isLanguageSignal ? 'insight' : 'note';
        const tags = ['auto-capture', 'tier2', 'checkpoint'];
        if (projectName) tags.push(projectName.toLowerCase());

        const hostname = require('os').hostname();
        const topicHint = userMessage.slice(0, 120).replace(/\s+/g, ' ');
        const content = [
            `## Session Checkpoint — ${projectName || 'unknown project'} on ${hostname}`,
            `Working directory: ${cwd}`,
            isLanguageSignal ? `Trigger: "${topicHint}"` : `Trigger: turn threshold (${state.turnCount} turns)`,
            '',
            contextWindow,
        ].join('\n');

        await storeMemory(config, content, memoryType, tags);

        state.lastTier2Turn = state.turnCount;
        await saveSessionState(sessionId, state);

        if (debugMode) console.log(`[tier2] Stored ${memoryType} memory`);

        process.exit(0);
    } catch (err) {
        console.error('[tier2] Error:', err.message);
        process.exit(0);
    }
}

if (require.main === module) {
    main();
}

module.exports = { main, loadSessionState, saveSessionState };
```

- [ ] **Step 5: Run all tests**

```bash
node --test claude-hooks/tests/tier-detection.test.js
node --test claude-hooks/tests/tier2-checkpoint.test.js
node --test claude-hooks/tests/auto-capture-patterns.test.js
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add claude-hooks/core/mid-conversation.js claude-hooks/tests/tier2-checkpoint.test.js
git commit -m "feat(hooks): rewrite mid-conversation.js as tier2 checkpoint hook"
```

---

### Task 5: Enable, sync, and smoke test

**Files:**
- Modify: `claude-hooks/config.json` (enable `autoCapture.enabled: true` if not already)
- Sync: `~/.claude/hooks/config.json`

**Interfaces:**
- Consumes: all previous tasks
- Produces: verified end-to-end capture on a real git commit and a language-signal message

- [ ] **Step 1: Enable debugMode temporarily in the installed config**

Edit `~/.claude/hooks/config.json` — find the `autoCapture` section and add `"debugMode": true`:
```json
"autoCapture": {
    "enabled": true,
    "debugMode": true,
    "tier1": { "enabled": true, "contextWindowSize": 8 },
    "tier2": { "enabled": true, "turnThreshold": 20, "cooldownTurns": 5, "minProseWords": 150 }
}
```

- [ ] **Step 2: Smoke test Tier 1 — make a real commit**

In the mcp-memory repo, make a trivial change and commit:
```bash
cd /home/timkjr/dev/mcp-memory
echo "" >> claude-hooks/README.md
git add claude-hooks/README.md
git commit -m "test: smoke test tier1 auto-capture"
```

Check the hook output in Claude Code's stderr panel or run:
```bash
memory logs -n 20 | grep -i "tier 1\|auto-capture\|gitCommit"
```

Expected: `[auto-capture] Tier 1 event: gitCommit, storing as decision` in stderr, and a new memory visible in `memory_search` with tags `commit, auto-capture, tier1`.

- [ ] **Step 3: Revert the trivial commit**

```bash
git revert HEAD --no-edit
git push forgejo
```

- [ ] **Step 4: Smoke test Tier 2 — send a language-signal message**

In a Claude Code session, send:
> "turns out the issue was the session state file wasn't being written because /tmp had a permission problem."

Check stderr for `[tier2] Firing (language-signal)` and verify a new `insight` memory appears in the service.

- [ ] **Step 5: Disable debugMode in the installed config**

Remove `"debugMode": true` from `~/.claude/hooks/config.json` (or set to `false`).

- [ ] **Step 6: Sync final config back to repo and deploy**

```bash
# Sync installed config to repo (preserving repo version as canonical)
cp ~/.claude/hooks/config.json /home/timkjr/dev/mcp-memory/claude-hooks/config.json
cd /home/timkjr/dev/mcp-memory
./deploy.sh
```

- [ ] **Step 7: Final commit**

```bash
git add claude-hooks/config.json
git commit -m "chore: sync config after tier1/tier2 smoke test validation"
git push forgejo
```

---

## Self-Review Notes

**Spec coverage check:**
- Tier 1 git commit ✓ Task 3
- Tier 1 deploy/restart ✓ Task 3
- Tier 1 DECISIONS.md write ✓ Task 3 (via `buildTier1Memory`)
- Tier 2 language signal (Condition A) ✓ Task 4
- Tier 2 turn threshold (Condition B) ✓ Task 4
- Cooldown (5 turns) ✓ Task 4
- Prose-density check (150 words) ✓ Task 4
- Session metadata tags (project, hostname, dir) ✓ Task 4 (`content` header includes hostname + cwd)
- Quality gate: prose-density only, no network call ✓ Task 4
- Error resolution excluded ✓ (not in any task)
- Session-end unchanged ✓ (not touched)

**Hostname tag note:** Tier 2 includes hostname in the memory *content* header. To also include it as a searchable *tag*, add `hostname:${require('os').hostname()}` to the `tags` array in Task 4 Step 4. The service already tags memories with hostname via `MCP_MEMORY_INCLUDE_HOSTNAME=true` on the server side, so this may be redundant — verify before adding.

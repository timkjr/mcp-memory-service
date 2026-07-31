/**
 * Claude Code Session End Auto-Harvest Hook
 *
 * Triggers POST /api/harvest on session end to extract learnings from the
 * session transcript. Opt-in, fail-safe, never blocks session end.
 *
 * Issue #631. Depends on PR #710 (v10.37.0+) for the harvest endpoint.
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { resolveConfigPath, applyEnvOverrides } = require('../utilities/config-loader');
const os = require('os');
const http = require('http');
const https = require('https');

const FIRST_RUN_FLAG_FILENAME = 'mcp-memory-harvest-first-run.done';
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MIN_MESSAGES = 10;

/**
 * Load hook configuration (same pattern as session-end.js).
 * Returns a safe default (disabled) when config is missing or unreadable.
 */
async function loadConfig() {
    try {
        const configPath = resolveConfigPath(__dirname);
        const data = await fsp.readFile(configPath, 'utf8');
        return applyEnvOverrides(JSON.parse(data));
    } catch (error) {
        console.warn('[Memory Hook] Harvest: using default configuration:', error.message);
        return {};
    }
}

/**
 * Build the Claude Code project directory name from a working directory.
 * Matches the Python side: str(Path.cwd()).replace(os.sep, '-')
 * Returns the full path identifier (project directory name used by Claude
 * Code under ~/.claude/projects/), with separators replaced by dashes —
 * e.g. "/Users/hkr/foo" -> "-Users-hkr-foo". Not a basename.
 */
function deriveProjectName(cwd) {
    if (!cwd) return null;
    // Python: str(Path.cwd()).replace(os.sep, "-")
    // On POSIX cwd starts with "/", giving "-Users-hkr-..."
    // On Windows cwd like "C:\\foo" becomes "C:-foo" — we mirror Python's behavior.
    const sep = path.sep;
    const joined = cwd.split(sep).join('-');
    // When cwd is absolute on POSIX, split yields ["", "Users", ...] -> "-Users-..."
    // which is already correct. On Windows there's no leading sep so prepend nothing.
    return joined;
}

/**
 * Get the first-run flag file path. Honors HOME env for testability.
 */
function firstRunFlagPath() {
    const home = process.env.HOME || os.homedir();
    return path.join(home, '.claude', FIRST_RUN_FLAG_FILENAME);
}

async function firstRunFlagExists() {
    try {
        await fsp.access(firstRunFlagPath(), fs.constants.F_OK);
        return true;
    } catch (_) {
        return false;
    }
}

async function writeFirstRunFlag() {
    const flagPath = firstRunFlagPath();
    try {
        await fsp.mkdir(path.dirname(flagPath), { recursive: true });
        await fsp.writeFile(flagPath, new Date().toISOString() + '\n', 'utf8');
    } catch (err) {
        console.warn('[Memory Hook] Harvest: could not write first-run flag:', err.message);
    }
}

/**
 * POST to /api/harvest with a hard timeout. Never throws.
 * Returns an object: { ok, status, body, error }.
 */
function postHarvest(endpoint, apiKey, payload, timeoutMs, options = {}) {
    return new Promise((resolve) => {
        let url;
        try {
            url = new URL('/api/harvest', endpoint);
        } catch (err) {
            return resolve({ ok: false, error: `Invalid endpoint: ${err.message}` });
        }

        const isHttps = url.protocol === 'https:';
        const requestModule = isHttps ? https : http;
        const body = JSON.stringify(payload);

        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
        };
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const requestOptions = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers,
            timeout: timeoutMs
        };
        if (isHttps && options.allowSelfSignedCerts === true) {
            requestOptions.rejectUnauthorized = false;
            console.warn(
                '[Memory Hook] Harvest: TLS certificate validation DISABLED ' +
                '(allowSelfSignedCerts=true). This leaves the hook vulnerable to MITM — ' +
                'use only for local development with self-signed certs.'
            );
        }

        const req = requestModule.request(requestOptions, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (_) { parsed = null; }
                const ok = res.statusCode >= 200 && res.statusCode < 300;
                resolve({ ok, status: res.statusCode, body: parsed, raw: data });
            });
        });

        req.on('error', (err) => {
            resolve({ ok: false, error: err.message });
        });
        req.on('timeout', () => {
            req.destroy();
            resolve({ ok: false, error: `timeout after ${timeoutMs}ms` });
        });

        req.write(body);
        req.end();
    });
}

/**
 * Summarize a harvest response for logging.
 */
function summarizeResponse(resp) {
    if (!resp || !resp.body || !Array.isArray(resp.body.results)) {
        return { found: 0, stored: 0, dryRun: null };
    }
    let found = 0;
    let stored = 0;
    for (const r of resp.body.results) {
        found += Number(r.found || 0);
        stored += Number(r.stored || 0);
    }
    return { found, stored, dryRun: !!resp.body.dry_run };
}

/**
 * Main hook entry point. Matches the Claude Code hook convention
 * (same shape as session-end.js: async function taking `context`).
 *
 * Never throws; all failures are logged as warnings.
 */
async function sessionEndHarvest(context) {
    try {
        // Read via module.exports._internal so tests can monkeypatch loadConfig.
        const config = await (module.exports._internal
            ? module.exports._internal.loadConfig()
            : loadConfig());
        const cfg = config.sessionHarvest || {};

        if (!cfg.enabled) {
            // Opt-in: do nothing unless user turned it on.
            return;
        }

        // Skip short sessions.
        const minMessages = Number.isFinite(cfg.minSessionMessages)
            ? cfg.minSessionMessages
            : DEFAULT_MIN_MESSAGES;
        const messages = (context && context.conversation && Array.isArray(context.conversation.messages))
            ? context.conversation.messages
            : [];
        if (messages.length < minMessages) {
            console.log(`[Memory Hook] Harvest: session has ${messages.length} messages (< ${minMessages}), skipping`);
            return;
        }

        // Derive project_path.
        const cwd = (context && context.workingDirectory) || process.cwd();
        const projectName = deriveProjectName(cwd);
        if (!projectName) {
            console.warn('[Memory Hook] Harvest: could not derive project name, skipping');
            return;
        }

        // First-run dry-run safety.
        const dryRunOnFirstUse = cfg.dryRunOnFirstUse !== false; // default true
        const isFirstRun = !(await firstRunFlagExists());
        const forcedDryRun = dryRunOnFirstUse && isFirstRun;
        const dryRun = forcedDryRun ? true : !!cfg.dryRun;

        if (forcedDryRun) {
            console.log('[Memory Hook] Harvest: first run detected, forcing dry_run=true');
        }

        // Resolve endpoint + api key.
        const endpoint = cfg.endpoint
            || config.memoryService?.http?.endpoint
            || config.memoryService?.endpoint
            || 'http://127.0.0.1:8000';
        const apiKey = context?.apiKey
            || cfg.apiKey
            || config.memoryService?.http?.apiKey
            || config.memoryService?.apiKey
            || process.env.MCP_API_KEY
            || null;

        const payload = {
            sessions: Number.isFinite(cfg.sessions) ? cfg.sessions : 1,
            use_llm: !!cfg.useLlm,
            dry_run: dryRun,
            min_confidence: Number.isFinite(cfg.minConfidence) ? cfg.minConfidence : 0.6,
            types: Array.isArray(cfg.types) && cfg.types.length > 0
                ? cfg.types
                : ['decision', 'bug', 'convention', 'learning', 'context'],
            project_path: projectName,
            ...(context?.transcriptContent ? { transcript_content: context.transcriptContent } : {})
        };

        const timeoutMs = Number.isFinite(cfg.timeoutMs) ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS;

        console.log(`[Memory Hook] Harvest: POST ${endpoint}/api/harvest (project=${projectName}, dry_run=${dryRun})`);

        const resp = await postHarvest(endpoint, apiKey, payload, timeoutMs, {
            allowSelfSignedCerts: cfg.allowSelfSignedCerts === true
        });

        if (!resp.ok) {
            const detail = resp.error
                || `HTTP ${resp.status}${resp.raw ? ' ' + String(resp.raw).slice(0, 200) : ''}`;
            console.warn(`[Memory Hook] Harvest: request failed (non-fatal): ${detail}`);
            return;
        }

        const { found, stored, dryRun: respDryRun } = summarizeResponse(resp);
        console.log(`[Memory Hook] Session harvest: ${found} candidates found, ${stored} stored (dry_run=${respDryRun})`);

        if (forcedDryRun) {
            await writeFirstRunFlag();
        }
    } catch (error) {
        // Absolute belt-and-braces: never let a harvest failure surface.
        console.warn('[Memory Hook] Harvest: unexpected error (non-fatal):', error.message);
    }
}

module.exports = sessionEndHarvest;

// Also expose internals for testing.
module.exports.sessionEndHarvest = sessionEndHarvest;
module.exports._internal = {
    loadConfig,
    deriveProjectName,
    firstRunFlagPath,
    firstRunFlagExists,
    writeFirstRunFlag,
    postHarvest,
    summarizeResponse,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_MIN_MESSAGES
};

/**
 * Read JSON context from stdin (Claude Code provides this to hook processes).
 * Resolves to null if stdin is empty within 100ms (manual test / no pipe).
 */
function readStdinContext() {
    return new Promise((resolve, reject) => {
        let data = '';
        const timeout = setTimeout(() => resolve(null), 100);
        process.stdin.setEncoding('utf8');
        process.stdin.on('readable', () => {
            let chunk;
            while ((chunk = process.stdin.read()) !== null) {
                data += chunk;
            }
        });
        process.stdin.on('end', () => {
            clearTimeout(timeout);
            if (!data.trim()) return resolve(null);
            try {
                resolve(JSON.parse(data));
            } catch (error) {
                console.error('[Memory Hook] Failed to parse stdin JSON:', error.message);
                reject(error);
            }
        });
        process.stdin.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });
    });
}

/**
 * Count messages in a Claude Code transcript JSONL file.
 * Errors are non-fatal — returns 0 so the hook gracefully degrades.
 */
async function countTranscriptMessages(transcriptPath) {
    const { count } = await readTranscript(transcriptPath);
    return count;
}

async function readTranscript(transcriptPath) {
    try {
        const raw = await fsp.readFile(transcriptPath, 'utf8');
        const filteredLines = [];
        let count = 0;

        for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            let parsed;
            try { parsed = JSON.parse(line); } catch (_) { continue; }
            if (!parsed || !parsed.type || !parsed.message) continue;
            count++;

            // Keep user messages as-is (they're always small).
            if (parsed.type === 'user') {
                filteredLines.push(line);
                continue;
            }

            // For assistant messages, keep only text content blocks — strip tool_use,
            // tool_result, and image blocks which are bulk and useless for harvest.
            if (parsed.type === 'assistant') {
                const msgContent = parsed.message && parsed.message.content;
                if (!Array.isArray(msgContent)) { filteredLines.push(line); continue; }
                const textOnly = msgContent.filter(b => b.type === 'text' && b.text && b.text.trim());
                if (textOnly.length === 0) continue; // pure tool-call turn, skip entirely
                const slim = { ...parsed, message: { ...parsed.message, content: textOnly } };
                filteredLines.push(JSON.stringify(slim));
            }
            // All other types (tool_result entries at top level, etc.) are dropped.
        }

        const MAX_BYTES = 768 * 1024; // 768KB — leaves headroom under the 1MB body limit
        const lineSizes = filteredLines.map(l => Buffer.byteLength(l + '\n', 'utf8'));
        const totalBytes = lineSizes.reduce((a, b) => a + b, 0);

        let sendLines;
        if (totalBytes <= MAX_BYTES) {
            sendLines = filteredLines;
        } else {
            // Always keep the first turn (session context), then fill remaining budget
            // from the most recent turns. Middle turns are dropped.
            const firstLine = filteredLines[0];
            const firstBytes = lineSizes[0];
            let budget = MAX_BYTES - firstBytes;
            let tailBytes = 0;
            let tailStart = filteredLines.length;
            for (let i = filteredLines.length - 1; i >= 1; i--) {
                if (tailBytes + lineSizes[i] > budget) break;
                tailBytes += lineSizes[i];
                tailStart = i;
            }
            sendLines = [firstLine, ...filteredLines.slice(tailStart)];
        }

        const content = sendLines.join('\n');
        const bytes = Buffer.byteLength(content, 'utf8');
        const trimmed = sendLines.length < filteredLines.length;
        console.log(`[Memory Hook] Harvest: ${count} total → ${filteredLines.length} text turns${trimmed ? `, trimmed to ${sendLines.length} (first + recent)` : ''} (${Math.round(bytes / 1024)}KB)`);
        return { count, content };
    } catch (error) {
        console.warn('[Memory Hook] Harvest: could not read transcript (non-fatal):', error.message);
        return { count: 0, content: null };
    }
}

module.exports._internal.readStdinContext = readStdinContext;
module.exports._internal.countTranscriptMessages = countTranscriptMessages;

// Hook metadata (mirrors session-end.js shape for discovery tools).
module.exports.metadata = {
    name: 'memory-awareness-session-end-harvest',
    version: '1.0.0',
    description: 'Auto-harvest learnings from session transcript on session end (opt-in)',
    trigger: 'session-end',
    handler: sessionEndHarvest,
    config: {
        async: true,
        timeout: DEFAULT_TIMEOUT_MS + 2000,
        priority: 'low'
    }
};

// Standalone CLI entry point. Claude Code invokes hooks as child processes and
// passes session context via stdin (see docs/hooks). When run without stdin
// this reduces to a no-op (useful for local troubleshooting).
if (require.main === module) {
    (async () => {
        try {
            const stdinContext = await readStdinContext();
            let context;
            if (stdinContext && stdinContext.transcript_path) {
                const { count: messageCount, content: transcriptContent } = await readTranscript(stdinContext.transcript_path);
                console.log(`[Memory Hook] Harvest: read ${messageCount} messages from ${stdinContext.transcript_path}`);
                context = {
                    workingDirectory: stdinContext.cwd || process.cwd(),
                    sessionId: stdinContext.session_id || 'unknown',
                    reason: stdinContext.reason,
                    transcriptContent,
                    conversation: {
                        messages: Array.from({ length: messageCount }, () => ({}))
                    }
                };
            } else {
                console.log('[Memory Hook] Harvest: no stdin context (manual run) — using cwd only');
                context = {
                    workingDirectory: process.cwd(),
                    sessionId: 'manual',
                    conversation: { messages: [] }
                };
            }
            await sessionEndHarvest(context);
            console.log('[Memory Hook] Harvest: hook completed');
        } catch (error) {
            console.error('[Memory Hook] Harvest: hook failed:', error.message);
            // Do not exit non-zero — a hook failure must not abort the session.
            process.exit(0);
        }
    })();
}

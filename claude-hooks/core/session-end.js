/**
 * Claude Code Session End Hook
 * Triggers memory_harvest + commits session learnings to the bootstrap
 * learning pipeline so the next session's profile is richer.
 */

const https = require('https');
const http = require('http');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../config.json');

async function loadConfig() {
    try {
        const fs = require('fs').promises;
        const data = await fs.readFile(CONFIG_PATH, 'utf8');
        return JSON.parse(data);
    } catch {
        return null;
    }
}

async function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        const timeout = setTimeout(() => resolve(null), 200);
        process.stdin.setEncoding('utf8');
        process.stdin.on('readable', () => {
            let chunk;
            while ((chunk = process.stdin.read()) !== null) data += chunk;
        });
        process.stdin.on('end', () => {
            clearTimeout(timeout);
            try { resolve(data.trim() ? JSON.parse(data) : null); }
            catch { resolve(null); }
        });
        process.stdin.on('error', () => { clearTimeout(timeout); resolve(null); });
    });
}

function post(endpoint, apiKey, body) {
    return new Promise((resolve) => {
        const url = new URL('/api/harvest', endpoint);
        const payload = JSON.stringify(body);
        const isHttps = url.protocol === 'https:';
        const mod = isHttps ? https : http;
        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'Authorization': `Bearer ${apiKey}`,
            },
            timeout: 30000,
            rejectUnauthorized: false,
        };
        const req = mod.request(options, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try { resolve({ ok: res.statusCode < 300, status: res.statusCode, body: JSON.parse(d) }); }
                catch { resolve({ ok: false, status: res.statusCode, body: d }); }
            });
        });
        req.on('error', e => resolve({ ok: false, error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
        req.write(payload);
        req.end();
    });
}

function postMCP(endpoint, apiKey, toolName, args) {
    return new Promise((resolve) => {
        const url = new URL('/mcp', endpoint);
        const payload = JSON.stringify({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: { name: toolName, arguments: args },
            id: 1,
        });
        const isHttps = url.protocol === 'https:';
        const mod = isHttps ? https : http;
        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'Authorization': `Bearer ${apiKey}`,
            },
            timeout: 15000,
            rejectUnauthorized: false,
        };
        const req = mod.request(options, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve({ ok: res.statusCode < 300, status: res.statusCode }));
        });
        req.on('error', () => resolve({ ok: false }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
        req.write(payload);
        req.end();
    });
}

/**
 * Map memory_harvest candidates into commit_session_legacy's
 * decisions/errors/belief_updates/task_summary arguments, mirroring the
 * server-side auto_commit bridge in handle_memory_harvest
 * (server_impl.py:1930-1955).
 */
function mapCandidatesToLegacyArgs(results, fallbackTaskSummary) {
    const decisions = [];
    const errors = [];
    const belief_updates = [];
    let task_summary = null;

    for (const result of results || []) {
        for (const candidate of result.candidates || []) {
            const content = candidate.content || '';
            switch (candidate.type) {
                case 'decision':
                    decisions.push({ decision: content.slice(0, 500), reason: 'harvested' });
                    break;
                case 'bug':
                    errors.push({ error: content.slice(0, 500), count: 1, severity: 'medium' });
                    break;
                case 'convention':
                case 'learning':
                    belief_updates.push({
                        belief: content.slice(0, 500),
                        new_confidence: Math.round((candidate.confidence ?? 0.75) * 100) / 100,
                    });
                    break;
                case 'context':
                    if (task_summary === null) task_summary = content.slice(0, 200);
                    break;
            }
        }
    }

    return {
        task_summary: task_summary ?? fallbackTaskSummary,
        decisions,
        errors,
        belief_updates,
    };
}

async function main() {
    try {
        const ctx = await readStdin();
        if (!ctx || !ctx.session_id) {
            console.log('[Memory Hook] No session context — skipping harvest');
            return;
        }

        const config = await loadConfig();
        if (!config) {
            console.log('[Memory Hook] No config — skipping harvest');
            return;
        }

        const endpoint = config.memoryService?.http?.endpoint;
        const apiKey   = config.memoryService?.http?.apiKey;
        if (!endpoint || !apiKey) {
            console.log('[Memory Hook] No endpoint/apiKey — skipping harvest');
            return;
        }

        console.log(`[Memory Hook] Harvesting session ${ctx.session_id}...`);

        const result = await post(endpoint, apiKey, {
            session_ids: [ctx.session_id],
            dry_run: false,
            use_llm: false,
            min_confidence: 0.6,
            project_path: ctx.cwd || null,
        });

        if (result.ok) {
            const b = result.body;
            const stored = b.results?.reduce((sum, r) => sum + (r.stored || 0), 0) ?? '?';
            console.log(`[Memory Hook] Harvest complete — ${stored} memories stored`);
        } else {
            console.warn(`[Memory Hook] Harvest failed (${result.status || result.error})`);
        }

        const fallbackTaskSummary = ctx.cwd ? `Session in ${ctx.cwd}` : 'Claude Code session';
        const legacyArgs = mapCandidatesToLegacyArgs(result.ok ? result.body?.results : [], fallbackTaskSummary);

        // Commit session legacy: feed decisions/errors into bootstrap learning pipeline
        await postMCP(endpoint, apiKey, 'commit_session_legacy', {
            session_id: ctx.session_id,
            agent_id: 'claude-code',
            task_summary: legacyArgs.task_summary,
            outcome: 'success',
            decisions: legacyArgs.decisions,
            errors: legacyArgs.errors,
            user_corrections: [],
            belief_updates: legacyArgs.belief_updates,
        });
        console.log('[Memory Hook] Session committed to learning pipeline');
    } catch (e) {
        console.error('[Memory Hook] Error:', e.message);
    }
}

module.exports = main;
module.exports._internal = { loadConfig, readStdin, post, postMCP, mapCandidatesToLegacyArgs };

if (require.main === module) {
    main();
}

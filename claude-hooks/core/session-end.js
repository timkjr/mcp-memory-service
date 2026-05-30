/**
 * Claude Code Session End Hook
 * Triggers memory_harvest on the completed session transcript.
 * Semantic extraction is handled by the memory service — not here.
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

(async () => {
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
            const stored = b.stored_count ?? b.candidates?.length ?? '?';
            console.log(`[Memory Hook] Harvest complete — ${stored} memories stored`);
        } else {
            console.warn(`[Memory Hook] Harvest failed (${result.status || result.error})`);
        }
    } catch (e) {
        console.error('[Memory Hook] Error:', e.message);
    }
})();

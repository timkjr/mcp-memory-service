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

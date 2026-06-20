#!/usr/bin/env node
/**
 * Tests for the harvest-candidate -> commit_session_legacy mapping in
 * claude-hooks/core/session-end.js.
 *
 * Uses Node's built-in assert (no external deps).
 * Run: node claude-hooks/tests/session-end-commit-legacy.test.js
 */

'use strict';

const assert = require('assert');

function freshHook() {
    const p = require.resolve('../core/session-end.js');
    delete require.cache[p];
    return require('../core/session-end.js');
}

async function runTest(name, fn) {
    try {
        await fn();
        console.log(`PASS: ${name}`);
        return true;
    } catch (err) {
        console.error(`FAIL: ${name}`);
        console.error(err);
        return false;
    }
}

async function main() {
    const results = [];

    results.push(await runTest('decision candidates map to decisions[]', async () => {
        const { mapCandidatesToLegacyArgs } = freshHook()._internal;
        const out = mapCandidatesToLegacyArgs([
            { session_id: 's1', candidates: [
                { type: 'decision', content: 'Use SQLite-Vec for local storage', confidence: 0.9, tags: [] },
            ] },
        ], 'fallback summary');

        assert.deepStrictEqual(out.decisions, [
            { decision: 'Use SQLite-Vec for local storage', reason: 'harvested' },
        ]);
        assert.deepStrictEqual(out.errors, []);
        assert.deepStrictEqual(out.belief_updates, []);
    }));

    results.push(await runTest('bug candidates map to errors[]', async () => {
        const { mapCandidatesToLegacyArgs } = freshHook()._internal;
        const out = mapCandidatesToLegacyArgs([
            { session_id: 's1', candidates: [
                { type: 'bug', content: 'Forgot to await the storage init', confidence: 0.8, tags: [] },
            ] },
        ], 'fallback summary');

        assert.deepStrictEqual(out.errors, [
            { error: 'Forgot to await the storage init', count: 1, severity: 'medium' },
        ]);
        assert.deepStrictEqual(out.decisions, []);
    }));

    results.push(await runTest('convention and learning candidates map to belief_updates[]', async () => {
        const { mapCandidatesToLegacyArgs } = freshHook()._internal;
        const out = mapCandidatesToLegacyArgs([
            { session_id: 's1', candidates: [
                { type: 'convention', content: 'Always tag memories with mcp-memory-service', confidence: 0.823, tags: [] },
                { type: 'learning', content: 'memory_harvest is local-only over /mcp', confidence: 0.75, tags: [] },
            ] },
        ], 'fallback summary');

        assert.deepStrictEqual(out.belief_updates, [
            { belief: 'Always tag memories with mcp-memory-service', new_confidence: 0.82 },
            { belief: 'memory_harvest is local-only over /mcp', new_confidence: 0.75 },
        ]);
    }));

    results.push(await runTest('first context candidate becomes task_summary, truncated to 200 chars', async () => {
        const { mapCandidatesToLegacyArgs } = freshHook()._internal;
        const longContent = 'x'.repeat(250);
        const out = mapCandidatesToLegacyArgs([
            { session_id: 's1', candidates: [
                { type: 'context', content: longContent, confidence: 0.7, tags: [] },
                { type: 'context', content: 'second context, should be ignored', confidence: 0.7, tags: [] },
            ] },
        ], 'fallback summary');

        assert.strictEqual(out.task_summary, 'x'.repeat(200));
    }));

    results.push(await runTest('falls back to provided task_summary when no context candidate', async () => {
        const { mapCandidatesToLegacyArgs } = freshHook()._internal;
        const out = mapCandidatesToLegacyArgs([
            { session_id: 's1', candidates: [
                { type: 'decision', content: 'Some decision', confidence: 0.9, tags: [] },
            ] },
        ], 'fallback summary');

        assert.strictEqual(out.task_summary, 'fallback summary');
    }));

    results.push(await runTest('empty/undefined results yield empty arrays and fallback task_summary', async () => {
        const { mapCandidatesToLegacyArgs } = freshHook()._internal;

        const outEmpty = mapCandidatesToLegacyArgs([], 'fallback summary');
        assert.deepStrictEqual(outEmpty, {
            task_summary: 'fallback summary',
            decisions: [],
            errors: [],
            belief_updates: [],
        });

        const outUndefined = mapCandidatesToLegacyArgs(undefined, 'fallback summary');
        assert.deepStrictEqual(outUndefined, {
            task_summary: 'fallback summary',
            decisions: [],
            errors: [],
            belief_updates: [],
        });
    }));

    results.push(await runTest('decision/error content is truncated to 500 chars', async () => {
        const { mapCandidatesToLegacyArgs } = freshHook()._internal;
        const longContent = 'y'.repeat(600);
        const out = mapCandidatesToLegacyArgs([
            { session_id: 's1', candidates: [
                { type: 'decision', content: longContent, confidence: 0.9, tags: [] },
                { type: 'bug', content: longContent, confidence: 0.9, tags: [] },
            ] },
        ], 'fallback summary');

        assert.strictEqual(out.decisions[0].decision.length, 500);
        assert.strictEqual(out.errors[0].error.length, 500);
    }));

    const passed = results.filter(Boolean).length;
    const total = results.length;
    console.log(`\n${passed}/${total} tests passed`);
    if (passed !== total) process.exit(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

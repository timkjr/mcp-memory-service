/**
 * Shared configuration path resolution for Claude Code memory hooks.
 *
 * Background (issue #155): the hooks can be installed two ways:
 *   1. Traditional install - files copied into ~/.claude/hooks/, so the
 *      bundled ../config.json IS ~/.claude/hooks/config.json.
 *   2. Marketplace plugin - files live in a version-pinned, read-only cache
 *      dir (~/.claude/plugins/cache/.../<version>/). There ../config.json
 *      points at the cache copy, so user edits to ~/.claude/hooks/config.json
 *      were ignored, and the cache copy is wiped on the next plugin upgrade.
 *
 * Resolution rule: prefer the user-owned ~/.claude/hooks/config.json when it
 * exists; otherwise fall back to the bundled config next to the hook package
 * (dev checkouts and traditional installs that never wrote the home file).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Absolute path to the user-owned hooks config.
 * @returns {string}
 */
function getUserConfigPath() {
    return path.join(os.homedir(), '.claude', 'hooks', 'config.json');
}

/**
 * Resolve which config.json a hook should read.
 *
 * @param {string} hookDir - The calling module's __dirname (e.g. core/).
 *   The bundled config is assumed to sit one level up (../config.json).
 * @returns {string} Absolute path to the config file that should be used.
 */
function resolveConfigPath(hookDir) {
    const userConfigPath = getUserConfigPath();
    if (fs.existsSync(userConfigPath)) {
        return userConfigPath;
    }
    return path.join(hookDir, '../config.json');
}

/**
 * Override memoryService apiKey fields with MEMORY_SERVICE_API_KEY from the
 * environment when set, so config.json never needs to carry the literal key.
 * Mutates and returns the same config object; handles both the nested
 * (memoryService.http.apiKey) and legacy flat (memoryService.apiKey) shapes.
 *
 * @param {object} config - Parsed hook config.
 * @returns {object} The same config object, with apiKey overridden if applicable.
 */
function applyEnvOverrides(config) {
    const envApiKey = process.env.MEMORY_SERVICE_API_KEY;
    if (!envApiKey || !config || !config.memoryService) {
        return config;
    }
    if (config.memoryService.http) {
        config.memoryService.http.apiKey = envApiKey;
    }
    if (Object.prototype.hasOwnProperty.call(config.memoryService, 'apiKey')) {
        config.memoryService.apiKey = envApiKey;
    }
    return config;
}

module.exports = { resolveConfigPath, getUserConfigPath, applyEnvOverrides };

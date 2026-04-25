// @ts-nocheck
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateConfigValue = exports.getConfigValue = exports.getLegacyConfig = exports.getConfig = exports.LEGACY_CONFIG_NAMESPACE = exports.CONFIG_NAMESPACE = void 0;
const vscode = require("vscode");
exports.CONFIG_NAMESPACE = 'markdownTranslator';
exports.LEGACY_CONFIG_NAMESPACE = 'mdcarrot';
function getConfig() {
    return vscode.workspace.getConfiguration(exports.CONFIG_NAMESPACE);
}
exports.getConfig = getConfig;
function getLegacyConfig() {
    return vscode.workspace.getConfiguration(exports.LEGACY_CONFIG_NAMESPACE);
}
exports.getLegacyConfig = getLegacyConfig;
function getExplicitConfigValue(config, key) {
    const inspected = config.inspect(key);
    const candidates = [
        inspected?.workspaceFolderLanguageValue,
        inspected?.workspaceFolderValue,
        inspected?.workspaceLanguageValue,
        inspected?.workspaceValue,
        inspected?.globalLanguageValue,
        inspected?.globalValue
    ];
    for (const value of candidates) {
        if (value !== undefined) {
            return value;
        }
    }
    return undefined;
}
function getConfigValue(key, fallbackValue) {
    const currentConfig = getConfig();
    const currentValue = getExplicitConfigValue(currentConfig, key);
    if (currentValue !== undefined) {
        return currentValue;
    }
    const legacyConfig = getLegacyConfig();
    const legacyValue = getExplicitConfigValue(legacyConfig, key);
    if (legacyValue !== undefined) {
        return legacyValue;
    }
    const defaultValue = currentConfig.inspect(key)?.defaultValue;
    if (defaultValue !== undefined) {
        return defaultValue;
    }
    const rawLegacyValue = legacyConfig.get(key);
    if (rawLegacyValue !== undefined) {
        return rawLegacyValue;
    }
    return fallbackValue;
}
exports.getConfigValue = getConfigValue;
async function updateConfigValue(key, value, target = vscode.ConfigurationTarget.Global) {
    await getConfig().update(key, value, target);
}
exports.updateConfigValue = updateConfigValue;
//# sourceMappingURL=config.js.map
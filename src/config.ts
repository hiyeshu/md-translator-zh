import * as vscode from 'vscode';

export const CONFIG_NAMESPACE = 'markdownTranslator';
export const LEGACY_CONFIG_NAMESPACE = 'mdcarrot';

export function getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
}

export function getLegacyConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(LEGACY_CONFIG_NAMESPACE);
}

function getExplicitConfigValue<T>(config: vscode.WorkspaceConfiguration, key: string): T | undefined {
    const inspected = config.inspect<T>(key);
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

export function getConfigValue<T>(key: string, fallbackValue: T): T {
    const currentConfig = getConfig();
    const currentValue = getExplicitConfigValue<T>(currentConfig, key);
    if (currentValue !== undefined) return currentValue;

    const legacyConfig = getLegacyConfig();
    const legacyValue = getExplicitConfigValue<T>(legacyConfig, key);
    if (legacyValue !== undefined) return legacyValue;

    const defaultValue = currentConfig.inspect<T>(key)?.defaultValue;
    if (defaultValue !== undefined) return defaultValue;

    const rawLegacyValue = legacyConfig.get<T>(key);
    if (rawLegacyValue !== undefined) return rawLegacyValue;

    return fallbackValue;
}

export async function updateConfigValue(key: string, value: unknown, target = vscode.ConfigurationTarget.Global): Promise<void> {
    await getConfig().update(key, value, target);
}

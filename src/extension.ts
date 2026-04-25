import * as vscode from 'vscode';
import { Logger } from './logger';
import { StatusBarManager } from './statusBar';
import { TranslationManager } from './translationManager';
import { TranslationViewerProvider } from './translationViewer';

const MARKDOWN_EXTENSIONS = ['.md', '.markdown'];

let translationViewerProvider: TranslationViewerProvider | null = null;
let statusBarManager: StatusBarManager | null = null;
let fallbackTranslationManager: TranslationManager | null = null;
let lastActiveMarkdownFile: vscode.Uri | null = null;

function getProviderLabel(providerName: string): string {
    const labels: Record<string, string> = {
        free: '免费',
        volcengine: '火山引擎',
        google: 'Google',
    };
    return labels[providerName] || providerName;
}

function isMarkdownFile(uri?: vscode.Uri | null): uri is vscode.Uri {
    return !!uri && MARKDOWN_EXTENSIONS.some(ext => uri.fsPath.toLowerCase().endsWith(ext));
}

function getTranslationManager(context: vscode.ExtensionContext): TranslationManager {
    if (translationViewerProvider?.translationManager) {
        return translationViewerProvider.translationManager;
    }
    if (!fallbackTranslationManager) {
        fallbackTranslationManager = new TranslationManager(context);
    }
    return fallbackTranslationManager;
}

function setupMarkdownFileTracking(context: vscode.ExtensionContext) {
    const syncLastActive = (uri?: vscode.Uri | null) => {
        if (isMarkdownFile(uri)) {
            lastActiveMarkdownFile = uri;
        }
    };

    syncLastActive(vscode.window.activeTextEditor?.document.uri);

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            syncLastActive(editor?.document.uri);
        }),
        vscode.workspace.onDidOpenTextDocument(document => {
            syncLastActive(document.uri);
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
            translationViewerProvider?.onFileChanged(event.document.uri);
        })
    );
}

async function findTargetMarkdownFile(
    uri?: vscode.Uri,
    selectedUris?: readonly vscode.Uri[]
): Promise<vscode.Uri | null> {
    if (isMarkdownFile(uri)) {
        return uri;
    }

    const selectedMarkdown = selectedUris?.find(isMarkdownFile);
    if (selectedMarkdown) {
        return selectedMarkdown;
    }

    if (isMarkdownFile(lastActiveMarkdownFile)) {
        try {
            await vscode.workspace.fs.stat(lastActiveMarkdownFile);
            return lastActiveMarkdownFile;
        } catch {
            lastActiveMarkdownFile = null;
        }
    }

    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (isMarkdownFile(activeUri)) {
        return activeUri;
    }

    return null;
}

async function openViewer(
    context: vscode.ExtensionContext,
    uri?: vscode.Uri,
    selectedUris?: readonly vscode.Uri[]
) {
    const targetUri = await findTargetMarkdownFile(uri, selectedUris);
    if (!targetUri) {
        vscode.window.showWarningMessage('先打开一个 Markdown 文件。');
        return;
    }

    if (!translationViewerProvider) {
        translationViewerProvider = new TranslationViewerProvider(context.extensionUri, context);
    }

    await translationViewerProvider.createOrShow(targetUri);
}

async function testConnection(context: vscode.ExtensionContext) {
    const manager = getTranslationManager(context);
    const providerName = manager.getCurrentProvider();
    const provider = manager.getCurrentProviderInstance();
    const providerLabel = getProviderLabel(providerName);

    statusBarManager?.showTranslating();

    try {
        if (providerName === 'free') {
            await provider.translate('Connection test');
            vscode.window.showInformationMessage('免费可用。稳定性不保证。');
            statusBarManager?.showReady();
            return;
        }

        const quota = await provider.getQuota?.();
        if (quota?.error && !/不会在这里直接返回剩余额度|没有统一额度接口/.test(quota.error)) {
            throw new Error(quota.error);
        }

        const detail = quota?.resetDate ? ` ${quota.resetDate}` : '';
        vscode.window.showInformationMessage(`${providerLabel} 连接正常。${detail}`.trim());
        statusBarManager?.showReady();
    } catch (error) {
        const message = error instanceof Error ? error.message : '连接失败';
        statusBarManager?.showError(message);
        vscode.window.showErrorMessage(`测试连接失败：${message}`);
    }
}

function clearAllCache(context: vscode.ExtensionContext) {
    getTranslationManager(context).clearAllCache();
}

function clearCurrentProviderCache(context: vscode.ExtensionContext) {
    getTranslationManager(context).clearProviderCache();
}

function showCacheStats(context: vscode.ExtensionContext) {
    const stats = getTranslationManager(context).getCacheStats();
    const providers = stats.providers.length > 0 ? stats.providers.join(', ') : '无';
    vscode.window.showInformationMessage(
        `文本缓存 ${stats.textEntries} 条，文件缓存 ${stats.fileEntries} 条，服务商：${providers}`
    );
}

export function activate(context: vscode.ExtensionContext) {
    Logger.initialize();
    statusBarManager = new StatusBarManager();
    statusBarManager.showReady();

    setupMarkdownFileTracking(context);

    context.subscriptions.push(
        statusBarManager,
        vscode.commands.registerCommand('mdcarrot.openViewer', (uri?: vscode.Uri, selectedUris?: readonly vscode.Uri[]) =>
            openViewer(context, uri, selectedUris)
        ),
        vscode.commands.registerCommand('mdcarrot.testConnection', () => testConnection(context)),
        vscode.commands.registerCommand('mdcarrot.clearCache', () => clearAllCache(context)),
        vscode.commands.registerCommand('mdcarrot.clearProviderCache', () => clearCurrentProviderCache(context)),
        vscode.commands.registerCommand('mdcarrot.showCacheStats', () => showCacheStats(context))
    );
}

export function deactivate() {
    translationViewerProvider?.dispose();
    translationViewerProvider = null;
    fallbackTranslationManager = null;
    statusBarManager?.dispose();
    statusBarManager = null;
    Logger.dispose();
}

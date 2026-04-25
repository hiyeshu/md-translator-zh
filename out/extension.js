"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
// @ts-nocheck
const vscode = __importStar(require("vscode"));
const logger_2 = require("./logger");
const statusBar_1 = require("./statusBar");
const translationManager_2 = require("./translationManager");
const translationViewer_1 = require("./translationViewer");
const MARKDOWN_EXTENSIONS = ['.md', '.markdown'];
let translationViewerProvider = null;
let statusBarManager = null;
let fallbackTranslationManager = null;
let lastActiveMarkdownFile = null;
function getProviderLabel(providerName) {
    const labels = {
        free: '免费',
        google: 'Google',
        azure: 'Azure',
        custom: '自定义 API',
    };
    return labels[providerName] || providerName;
}
function isMarkdownFile(uri) {
    return !!uri && MARKDOWN_EXTENSIONS.some(ext => uri.fsPath.toLowerCase().endsWith(ext));
}
function getTranslationManager(context) {
    if (translationViewerProvider?.translationManager) {
        return translationViewerProvider.translationManager;
    }
    if (!fallbackTranslationManager) {
        fallbackTranslationManager = new translationManager_2.TranslationManager(context);
    }
    return fallbackTranslationManager;
}
function setupMarkdownFileTracking(context) {
    const syncLastActive = (uri) => {
        if (isMarkdownFile(uri)) {
            lastActiveMarkdownFile = uri;
        }
    };
    syncLastActive(vscode.window.activeTextEditor?.document.uri);
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        syncLastActive(editor?.document.uri);
    }), vscode.workspace.onDidOpenTextDocument(document => {
        syncLastActive(document.uri);
    }), vscode.workspace.onDidChangeTextDocument(event => {
        translationViewerProvider?.onFileChanged(event.document.uri);
    }));
}
async function findTargetMarkdownFile(uri, selectedUris) {
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
        }
        catch {
            lastActiveMarkdownFile = null;
        }
    }
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (isMarkdownFile(activeUri)) {
        return activeUri;
    }
    return null;
}
async function openViewer(context, uri, selectedUris) {
    const targetUri = await findTargetMarkdownFile(uri, selectedUris);
    if (!targetUri) {
        vscode.window.showWarningMessage('先打开一个 Markdown 文件。');
        return;
    }
    if (!translationViewerProvider) {
        translationViewerProvider = new translationViewer_1.TranslationViewerProvider(context.extensionUri, context);
    }
    await translationViewerProvider.createOrShow(targetUri);
}
async function testConnection(context) {
    const manager = getTranslationManager(context);
    const providerName = manager.getCurrentProvider();
    const provider = manager.getCurrentProviderInstance();
    const providerLabel = getProviderLabel(providerName);
    statusBarManager?.showTranslating();
    try {
        if (providerName === 'custom' || providerName === 'free') {
            await provider.translate('Connection test');
            const message = providerName === 'free'
                ? '免费可用。稳定性不保证。'
                : '自定义 API 连接正常。';
            vscode.window.showInformationMessage(message);
            statusBarManager?.showReady();
            return;
        }
        const quota = await provider.getQuota();
        if (quota?.error && !/不会在这里直接返回剩余额度|没有统一额度接口/.test(quota.error)) {
            throw new Error(quota.error);
        }
        const detail = quota?.resetDate ? ` ${quota.resetDate}` : '';
        vscode.window.showInformationMessage(`${providerLabel} 连接正常。${detail}`.trim());
        statusBarManager?.showReady();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : '连接失败';
        statusBarManager?.showError(message);
        vscode.window.showErrorMessage(`测试连接失败：${message}`);
    }
}
function clearAllCache(context) {
    getTranslationManager(context).clearAllCache();
}
function clearCurrentProviderCache(context) {
    getTranslationManager(context).clearProviderCache();
}
function showCacheStats(context) {
    const stats = getTranslationManager(context).getCacheStats();
    const providers = stats.providers.length > 0 ? stats.providers.join(', ') : '无';
    vscode.window.showInformationMessage(`文本缓存 ${stats.textEntries} 条，文件缓存 ${stats.fileEntries} 条，服务商：${providers}`);
}
function activate(context) {
    logger_2.Logger.initialize();
    statusBarManager = new statusBar_1.StatusBarManager();
    statusBarManager.showReady();
    setupMarkdownFileTracking(context);
    context.subscriptions.push(statusBarManager, vscode.commands.registerCommand('mdcarrot.openViewer', (uri, selectedUris) => openViewer(context, uri, selectedUris)), vscode.commands.registerCommand('mdcarrot.testConnection', () => testConnection(context)), vscode.commands.registerCommand('mdcarrot.clearCache', () => clearAllCache(context)), vscode.commands.registerCommand('mdcarrot.clearProviderCache', () => clearCurrentProviderCache(context)), vscode.commands.registerCommand('mdcarrot.showCacheStats', () => showCacheStats(context)));
}
exports.activate = activate;
function deactivate() {
    translationViewerProvider?.dispose();
    translationViewerProvider = null;
    fallbackTranslationManager = null;
    statusBarManager?.dispose();
    statusBarManager = null;
    logger_2.Logger.dispose();
}
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map
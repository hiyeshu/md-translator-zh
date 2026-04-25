import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';
import { TranslationManager } from './translationManager';
import { MarkdownProcessor, TextNode } from './markdownProcessor';
import { getConfigValue, updateConfigValue } from './config';

const DEFAULT_TARGET_LANGUAGE = 'zh-CN';
const VOLCENGINE_TUTORIAL_URL = 'https://github.com/hiyeshu/md-translator-zh/blob/main/docs/volcengine-machine-translation.md';
function getProviderLabel(provider: string): string {
    const labels: Record<string, string> = {
        free: '免费',
        volcengine: '火山引擎',
        google: 'Google',
    };
    return labels[provider] || provider;
}
function getTargetLanguageLabel() {
    return DEFAULT_TARGET_LANGUAGE === 'zh-CN' ? '简体中文' : '繁体中文';
}
function getTargetFileSuffix() {
    return `_${DEFAULT_TARGET_LANGUAGE}`;
}
export class TranslationViewerProvider {
    static readonly DEBOUNCE_DELAY = 1000;

    private extensionUri: vscode.Uri;
    private context: vscode.ExtensionContext;
    private markdownProcessor: MarkdownProcessor;
    private isUpdating = false;
    private disposables: vscode.Disposable[] = [];
    private currentTranslatedContent = '';
    private currentProvider = '';
    private translationState: string = 'empty';
    private currentFileContent = '';
    private lastTranslatedNodes: TextNode[] = [];
    translationManager: TranslationManager;
    private panel?: vscode.WebviewPanel;
    private currentFileUri?: vscode.Uri;
    private updateTimeout?: ReturnType<typeof setTimeout>;
    constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this.extensionUri = extensionUri;
        this.context = context;
        this.markdownProcessor = new MarkdownProcessor();
        this.isUpdating = false;
        this.disposables = [];
        this.currentTranslatedContent = '';
        this.currentProvider = '';
        this.translationState = 'empty';
        this.currentFileContent = '';
        this.lastTranslatedNodes = [];
        this.translationManager = new TranslationManager(context);
    }
    dispose() {
        this.cleanup();
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
    onFileChanged(uri: vscode.Uri) {
        if (this.currentFileUri &&
            uri.fsPath === this.currentFileUri.fsPath &&
            this.panel &&
            !this.isUpdating) {
            clearTimeout(this.updateTimeout);
            this.updateTimeout = setTimeout(() => {
                this.updateContentDelta(uri);
            }, TranslationViewerProvider.DEBOUNCE_DELAY);
        }
    }
    async createOrShow(fileUri: vscode.Uri) {
        try {
            // Web-compatible file validation
            await vscode.workspace.fs.stat(fileUri);
        }
        catch (error) {
            vscode.window.showErrorMessage('File not found or not accessible');
            return;
        }
        this.currentFileUri = fileUri;
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside);
            await this.updateContent(fileUri);
            return;
        }
        const fileName = this.getFileName(fileUri);
        // Essential webview pattern for web compatibility
        this.panel = vscode.window.createWebviewPanel('mdTranslator', `Markdown 中文翻译器: ${fileName}`, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [this.extensionUri]
        });
        // Setup event handlers
        this.disposables.push(this.panel.onDidDispose(() => this.cleanup()), this.panel.webview.onDidReceiveMessage(async (message) => {
            await this.handleWebviewMessage(message, fileUri);
        }));
        await this.updateContent(fileUri);
        // Auto-translate after webview is ready
        setTimeout(async () => {
            await this.autoTranslate(fileUri);
        }, 800);
    }
    async autoTranslate(fileUri: vscode.Uri) {
        try {
            if (!this.panel)
                return;
            // Check if already translated or loading
            if (this.translationState === 'loading' || this.translationState === 'translated') {
                return;
            }
            // Only auto-translate if we have content and no cached translation
            const content = fs.readFileSync(fileUri.fsPath, 'utf8');
            if (!this.translationManager.isFileCached(fileUri.fsPath, content)) {
                Logger.info('Auto-translating file on open...');
                await this.updateContent(fileUri);
            }
        }
        catch (error) {
            Logger.error('Auto-translation failed:', error instanceof Error ? error : undefined);
        }
    }
    async handleWebviewMessage(message: { command: string; provider?: string; content?: string; query?: string; url?: string; settings?: Record<string, string> }, fileUri: vscode.Uri) {
        try {
            switch (message.command) {
                case 'save':
                    if (typeof message.content === 'string') {
                        await this.saveTranslation(fileUri, message.content);
                    }
                    break;
                case 'refresh':
                    await this.updateContent(fileUri);
                    break;
                case 'forceRefresh':
                    await this.forceRefresh(fileUri);
                    break;
                case 'changeProvider':
                    if (typeof message.provider === 'string') {
                        await this.changeProvider(message.provider, fileUri);
                    }
                    break;
                case 'getSettings':
                    this.panel?.webview.postMessage({
                        command: 'settingsData',
                        settings: {
                            provider: getConfigValue('provider', 'free'),
                            'volcengine.accessKeyId': getConfigValue('volcengine.accessKeyId', ''),
                            'volcengine.secretKey': getConfigValue('volcengine.secretKey', ''),
                            'volcengine.region': getConfigValue('volcengine.region', 'cn-north-1'),
                            'google.apiKey': getConfigValue('google.apiKey', ''),
                            'free.googleMirror': getConfigValue('free.googleMirror', ''),
                        }
                    });
                    break;
                case 'saveSettings':
                    if (message.settings) {
                        for (const [key, value] of Object.entries(message.settings)) {
                            await updateConfigValue(key, value, vscode.ConfigurationTarget.Global);
                        }
                        vscode.window.showInformationMessage('设置已保存');
                        this.panel?.webview.postMessage({ command: 'settingsSaved' });
                    }
                    break;
                case 'testConnection': {
                    const provider = this.translationManager.getCurrentProviderInstance();
                    try {
                        await provider.translate('hello');
                        this.panel?.webview.postMessage({ command: 'testResult', success: true, message: '连接正常' });
                    } catch (e) {
                        this.panel?.webview.postMessage({ command: 'testResult', success: false, message: e instanceof Error ? e.message : '连接失败' });
                    }
                    break;
                }
                case 'openSettings':
                    vscode.commands.executeCommand('workbench.action.openSettings', message.query || 'markdownTranslator');
                    break;
                case 'openExternal':
                    if (typeof message.url === 'string' && message.url) {
                        await vscode.env.openExternal(vscode.Uri.parse(message.url));
                    }
                    break;
                default:
                    console.warn('Unknown webview message:', message.command);
            }
        }
        catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`操作失败：${errorMsg}`);
        }
    }
    async forceRefresh(fileUri: vscode.Uri) {
        // Clear file cache
        this.translationManager.clearFileCache(fileUri.fsPath);
        // Show loading state
        this.showLoadingState();
        vscode.window.showInformationMessage(`正在用 ${getProviderLabel(this.getSelectedProvider())} 重新翻译...`);
        // Force update without cache
        await this.updateContentWithoutCache(fileUri);
    }
    getSelectedProvider() {
        return getConfigValue('provider', 'free') || 'free';
    }
    async updateContentWithoutCache(fileUri: vscode.Uri) {
        if (!this.panel || this.isUpdating)
            return;
        this.isUpdating = true;
        try {
            // Validate file exists and is readable
            if (!fs.existsSync(fileUri.fsPath)) {
                throw new Error('File not found');
            }
            const stats = fs.statSync(fileUri.fsPath);
            if (!stats.isFile()) {
                throw new Error('Path is not a file');
            }
            if (stats.size > 10 * 1024 * 1024) { // 10MB limit
                throw new Error('File too large (max 10MB)');
            }
            const content = fs.readFileSync(fileUri.fsPath, 'utf8');
            // Extract text nodes for translation
            const textNodes = this.markdownProcessor.extractTextNodes(content);
            const textValues = textNodes.map(node => node.value).filter(text => text.trim());
            if (textValues.length === 0) {
                if (this.panel) {
                    this.panel.webview.html = this.getNoContentMessage();
                }
                return;
            }
            // Force translate without cache by clearing cache first
            await this.translationManager.clearTextCache(textValues);
            const translations = await this.translationManager.translateBatch(textValues);
            // Check if panel still exists and we're still updating the same file
            if (!this.panel || this.currentFileUri?.fsPath !== fileUri.fsPath) {
                return;
            }
            // Rebuild markdown with translations
            const translatedNodes = textNodes.map((node, index) => ({
                ...node,
                value: translations[index] || node.value
            }));
            // Cache the file translation
            this.translationManager.cacheFileTranslation(fileUri.fsPath, content, translatedNodes);
            const translatedMarkdown = this.markdownProcessor.reconstructMarkdown(content, translatedNodes);
            // Convert to HTML for better rendering
            const originalHtml = this.markdownProcessor.convertToHtml(content);
            const translatedHtml = this.markdownProcessor.convertToHtml(translatedMarkdown);
            if (this.panel && this.currentFileUri?.fsPath === fileUri.fsPath) {
                this.updateTranslationComplete(translatedMarkdown);
                this.panel.webview.html = this.getWebviewContent(originalHtml, translatedHtml, translatedMarkdown);
            }
        }
        catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            console.error('Force refresh failed:', error);
            if (this.panel) {
                this.panel.webview.html = this.getErrorContent(`重新翻译失败：${errorMsg}`);
            }
        }
        finally {
            this.isUpdating = false;
        }
    }
    async changeProvider(provider: string, fileUri: vscode.Uri) {
        await updateConfigValue('provider', provider, vscode.ConfigurationTarget.Global);
        const providerLabel = getProviderLabel(provider);
        // Check if switching back to the provider that created current content
        const isSameAsCurrentContent = (this.currentProvider === provider && this.translationState === 'translated');
        // Only auto-translate if no content exists
        if (this.translationState === 'empty') {
            vscode.window.showInformationMessage(`已切到 ${providerLabel}，开始翻译。`);
            await this.updateContent(fileUri);
        }
        else if (isSameAsCurrentContent) {
            // Switching back to same provider - content is still up-to-date
            vscode.window.showInformationMessage(`当前译文已经是由 ${providerLabel} 生成。`);
            this.updateMemoToCompleted(provider);
        }
        else {
            // Different provider - show warning
            vscode.window.showInformationMessage(`已切到 ${providerLabel}，当前译文还没同步。`);
            this.updateMemoOnly(provider);
        }
    }
    updateTranslationComplete(translatedMarkdown: string) {
        this.translationState = 'translated';
        this.currentTranslatedContent = translatedMarkdown;
        const provider = getConfigValue('provider', 'free') || 'free';
        this.currentProvider = provider; // This tracks which provider created the current content
        // Update memo to show completion
        if (this.panel) {
            this.panel.webview.postMessage({
                command: 'updateMemo',
                provider: provider,
                state: 'completed'
            });
        }
    }
    showLoadingState() {
        if (this.panel) {
            this.translationState = 'loading';
            const currentProvider: string = getConfigValue('provider', 'free') || 'free';
            this.panel.webview.postMessage({
                command: 'updateMemo',
                provider: currentProvider,
                state: 'loading'
            });
        }
    }
    detectContentDeltas(oldContent: string, newContent: string) {
        if (!oldContent || !newContent) {
            return [];
        }
        const deltas = [];
        const oldLines = oldContent.split('\n');
        const newLines = newContent.split('\n');
        // Use simple diff algorithm to find changed lines
        let oldIndex = 0;
        let newIndex = 0;
        while (oldIndex < oldLines.length || newIndex < newLines.length) {
            const oldLine = oldLines[oldIndex] || '';
            const newLine = newLines[newIndex] || '';
            if (oldLine === newLine) {
                // Lines match, move forward
                oldIndex++;
                newIndex++;
            }
            else {
                // Found a difference - find the extent of the change
                const changeStart = newIndex;
                let changeEnd = newIndex;
                // Find end of changed block by looking ahead
                while (changeEnd < newLines.length) {
                    const futureOldIndex = oldIndex + (changeEnd - changeStart);
                    if (futureOldIndex < oldLines.length &&
                        newLines[changeEnd] === oldLines[futureOldIndex]) {
                        break;
                    }
                    changeEnd++;
                }
                // Create delta for this change
                const changedText = newLines.slice(changeStart, changeEnd).join('\n');
                const originalText = oldLines.slice(oldIndex, oldIndex + (changeEnd - changeStart)).join('\n');
                if (changedText.trim()) { // Only include non-empty changes
                    deltas.push({
                        startIndex: changeStart,
                        endIndex: changeEnd,
                        oldText: originalText,
                        newText: changedText,
                        semanticBoundary: this.isSemanticBoundary(changedText)
                    });
                }
                // Move indices forward
                oldIndex += (changeEnd - changeStart);
                newIndex = changeEnd;
            }
        }
        return deltas;
    }
    isSemanticBoundary(text: string) {
        const trimmed = text.trim();
        // Empty or whitespace-only
        if (!trimmed)
            return false;
        // Complete sentences with proper punctuation
        if (/[.!?]["']?\s*$/.test(trimmed))
            return true;
        // Markdown structures
        if (/^#+\s/.test(trimmed))
            return true; // Headers
        if (/^[-*+]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed))
            return true; // Lists
        if (/^>\s/.test(trimmed))
            return true; // Blockquotes
        if (/^```/.test(trimmed))
            return true; // Code blocks
        if (/^\|.*\|/.test(trimmed))
            return true; // Tables
        // Complete paragraphs (separated by blank lines)
        if (text.includes('\n\n'))
            return true;
        // Avoid breaking mid-sentence (contains comma but no period)
        if (/,\s*$/.test(trimmed) && !/[.!?]/.test(trimmed))
            return false;
        // Short fragments are likely incomplete
        if (trimmed.length < 10)
            return false;
        return true;
    }
    calculateCost(charCount: number) {
        const provider = getConfigValue('provider', 'free') || 'free';
        // Cost per character by provider
        const costs = {
            'free': 0,
            'volcengine': 0.0000035,
            'google': 0.00002,
        };
        return charCount * (costs[provider] || costs.google);
    }
    updateMemoToCompleted(provider: string) {
        if (this.panel) {
            this.panel.webview.postMessage({
                command: 'updateMemo',
                provider: provider,
                state: 'completed'
            });
        }
    }
    updateMemoOnly(newProvider: string) {
        if (this.panel) {
            this.panel.webview.postMessage({
                command: 'updateMemo',
                provider: newProvider,
                state: 'provider-changed'
            });
        }
    }
    cleanup() {
        clearTimeout(this.updateTimeout);
        this.updateTimeout = undefined;
        this.panel = undefined;
        this.currentFileUri = undefined;
        this.currentFileContent = '';
        this.lastTranslatedNodes = [];
        this.currentTranslatedContent = '';
        this.isUpdating = false;
        this.translationState = 'empty';
    }
    getFileName(uri: vscode.Uri) {
        return path.basename(uri.fsPath) || 'Unknown';
    }
    async updateContentDelta(fileUri: vscode.Uri) {
        if (!this.panel || this.isUpdating)
            return;
        this.isUpdating = true;
        try {
            const newContent = fs.readFileSync(fileUri.fsPath, 'utf8');
            // If no previous content, do full translation
            if (!this.currentFileContent) {
                await this.updateContent(fileUri);
                return;
            }
            // Detect changes
            const deltas = this.detectContentDeltas(this.currentFileContent, newContent);
            if (deltas.length === 0) {
                Logger.debug('No content changes detected');
                return;
            }
            // Filter out non-semantic deltas and merge small adjacent changes
            const semanticDeltas = this.optimizeDeltas(deltas);
            if (semanticDeltas.length === 0) {
                Logger.debug('No semantic changes detected');
                return;
            }
            // Calculate cost savings
            const totalChars = newContent.length;
            const deltaChars = semanticDeltas.reduce((sum, d) => sum + d.newText.length, 0);
            const savings = Math.round((1 - deltaChars / totalChars) * 100);
            // If savings are minimal, do full translation instead
            if (savings < 20) {
                Logger.debug('Delta savings too small, doing full translation');
                await this.updateContent(fileUri);
                return;
            }
            Logger.debug(`Delta translation: ${semanticDeltas.length} changes, ${deltaChars}/${totalChars} chars (${savings}% savings)`);
            // Show delta loading state with progress
            if (this.panel) {
                const provider = getConfigValue('provider', 'free') || 'free';
                this.panel.webview.postMessage({
                    command: 'updateMemo',
                    provider: provider,
                    state: 'delta-loading',
                    savings: savings,
                    progress: `0/${semanticDeltas.length}`
                });
            }
            // Translate only the deltas with progress updates
            const deltaTranslations = await this.translationManager.translateDeltasWithProgress(semanticDeltas, (completed, total) => {
                if (this.panel) {
                    const provider = getConfigValue('provider', 'free') || 'free';
                    this.panel.webview.postMessage({
                        command: 'updateMemo',
                        provider: provider,
                        state: 'delta-loading',
                        savings: savings,
                        progress: `${completed}/${total}`
                    });
                }
            });
            if (deltaTranslations.length !== semanticDeltas.length) {
                throw new Error('Translation count mismatch');
            }
            // Reconstruct content with translated deltas
            const translatedContent = this.applyDeltaTranslations(newContent, semanticDeltas, deltaTranslations);
            // Validate result
            if (!translatedContent || translatedContent.length < newContent.length * 0.5) {
                throw new Error('Translation result appears corrupted');
            }
            // Update display
            const originalHtml = this.markdownProcessor.convertToHtml(newContent);
            const translatedHtml = this.markdownProcessor.convertToHtml(translatedContent);
            if (this.panel && this.currentFileUri?.fsPath === fileUri.fsPath) {
                this.updateTranslationComplete(translatedContent);
                this.currentFileContent = newContent;
                // Show delta completion with savings
                this.panel.webview.postMessage({
                    command: 'updateMemo',
                    provider: this.currentProvider,
                    state: 'delta-completed',
                    savings: savings
                });
                this.panel.webview.html = this.getWebviewContent(originalHtml, translatedHtml, translatedContent);
            }
        }
        catch (error) {
            console.error('Delta translation failed:', error);
            vscode.window.showWarningMessage('Delta translation failed, falling back to full translation');
            // Fallback to full translation
            await this.updateContent(fileUri);
        }
        finally {
            this.isUpdating = false;
        }
    }
    optimizeDeltas(deltas: { oldText: string; newText: string; semanticBoundary?: boolean; startIndex?: number; endIndex?: number }[]) {
        const optimized = [];
        for (const delta of deltas) {
            // Skip empty or whitespace-only changes
            if (!delta.newText.trim())
                continue;
            // Skip very small changes unless they're semantic
            if (delta.newText.length < 3 && !delta.semanticBoundary)
                continue;
            // Merge adjacent deltas
            const lastDelta = optimized[optimized.length - 1];
            if (lastDelta && delta.startIndex === lastDelta.endIndex) {
                lastDelta.endIndex = delta.endIndex;
                lastDelta.newText += '\n' + delta.newText;
                lastDelta.oldText += '\n' + delta.oldText;
                lastDelta.semanticBoundary = lastDelta.semanticBoundary || delta.semanticBoundary;
            }
            else {
                optimized.push(delta);
            }
        }
        return optimized.filter(delta => this.isSemanticBoundary(delta.newText));
    }
    applyDeltaTranslations(content: string, deltas: { oldText: string; newText: string; startIndex?: number; endIndex?: number }[], translations: string[]) {
        const lines = content.split('\n');
        let translationIndex = 0;
        // Apply translations in reverse order to avoid index shifting
        const sortedDeltas = [...deltas].sort((a, b) => (b.startIndex ?? 0) - (a.startIndex ?? 0));
        for (const delta of sortedDeltas) {
            if (translationIndex < translations.length) {
                const translation = translations[translations.length - 1 - translationIndex];
                const translationLines = translation.split('\n');
                lines.splice(delta.startIndex ?? 0, (delta.endIndex ?? 0) - (delta.startIndex ?? 0), ...translationLines);
                translationIndex++;
            }
        }
        return lines.join('\n');
    }
    async updateContent(fileUri: vscode.Uri) {
        if (!this.panel || this.isUpdating)
            return;
        this.isUpdating = true;
        try {
            // Web-compatible file operations
            const stats = await vscode.workspace.fs.stat(fileUri);
            if (stats.type !== vscode.FileType.File) {
                throw new Error('Path is not a file');
            }
            if (stats.size > 10 * 1024 * 1024) { // 10MB limit
                throw new Error('File too large (max 10MB)');
            }
            const contentBytes = await vscode.workspace.fs.readFile(fileUri);
            const content = Buffer.from(contentBytes).toString('utf8');
            // Check cache first
            if (this.translationManager.isFileCached(fileUri.fsPath, content)) {
                const cachedNodes = this.translationManager.getCachedFileTranslation(fileUri.fsPath);
                if (cachedNodes && this.panel) {
                    const translatedMarkdown = this.markdownProcessor.reconstructMarkdown(content, cachedNodes);
                    const originalHtml = this.markdownProcessor.convertToHtml(content);
                    const translatedHtml = this.markdownProcessor.convertToHtml(translatedMarkdown);
                    this.updateTranslationComplete(translatedMarkdown);
                    this.currentFileContent = content;
                    this.lastTranslatedNodes = cachedNodes;
                    this.panel.webview.html = this.getWebviewContent(originalHtml, translatedHtml, translatedMarkdown);
                    return;
                }
            }
            // Show loading state
            if (this.panel) {
                this.panel.webview.html = this.getLoadingContent();
            }
            // Extract and translate text
            const textNodes = this.markdownProcessor.extractTextNodes(content);
            const textValues = textNodes.map(node => node.value).filter(text => text.trim());
            if (textValues.length === 0) {
                if (this.panel) {
                    this.panel.webview.html = this.getNoContentMessage();
                }
                return;
            }
            const translations = await this.translationManager.translateBatch(textValues);
            // Check if panel still exists
            if (!this.panel || this.currentFileUri?.fsPath !== fileUri.fsPath) {
                return;
            }
            // Build final content
            const translatedNodes = textNodes.map((node, index) => ({
                ...node,
                value: translations[index] || node.value
            }));
            this.translationManager.cacheFileTranslation(fileUri.fsPath, content, translatedNodes);
            const translatedMarkdown = this.markdownProcessor.reconstructMarkdown(content, translatedNodes);
            const originalHtml = this.markdownProcessor.convertToHtml(content);
            const translatedHtml = this.markdownProcessor.convertToHtml(translatedMarkdown);
            if (this.panel && this.currentFileUri?.fsPath === fileUri.fsPath) {
                this.updateTranslationComplete(translatedMarkdown);
                this.panel.webview.html = this.getWebviewContent(originalHtml, translatedHtml, translatedMarkdown);
            }
        }
        catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`翻译失败：${errorMsg}`);
            if (this.panel) {
                this.panel.webview.html = this.getErrorContent(errorMsg);
            }
        }
        finally {
            this.isUpdating = false;
        }
    }
    async saveTranslation(originalUri: vscode.Uri, content: string) {
        if (!content || typeof content !== 'string') {
            throw new Error('Invalid content to save');
        }
        const originalPath = originalUri.fsPath;
        // Validate original file still exists
        if (!fs.existsSync(originalPath)) {
            throw new Error('Original file no longer exists');
        }
        const dir = path.dirname(originalPath);
        const ext = path.extname(originalPath);
        const name = path.basename(originalPath, ext);
        const newPath = path.join(dir, `${name}${getTargetFileSuffix()}${ext}`);
        // Check if target directory is writable
        try {
            fs.accessSync(dir, fs.constants.W_OK);
        }
        catch {
            throw new Error('Directory is not writable');
        }
        // Backup existing file if it exists
        if (fs.existsSync(newPath)) {
            const backupPath = path.join(dir, `${name}${getTargetFileSuffix()}.backup${ext}`);
            fs.copyFileSync(newPath, backupPath);
        }
        fs.writeFileSync(newPath, content, 'utf8');
        vscode.window.showInformationMessage(`译文已导出到 ${path.basename(newPath)}`);
        // Open the saved file
        const savedUri = vscode.Uri.file(newPath);
        await vscode.window.showTextDocument(savedUri, { viewColumn: vscode.ViewColumn.Active });
    }
    getNoContentMessage() {
        return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; worker-src 'none'; child-src 'none';">
            <title>没有可翻译内容</title>
            <style>
                body {
                    margin: 0;
                    background: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    font-family: var(--vscode-font-family);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    min-height: 100vh;
                }
                .empty {
                    font-size: 14px;
                    color: var(--vscode-descriptionForeground);
                }
            </style>
        </head>
        <body>
            <div class="empty">没有可翻译内容</div>
        </body>
        </html>`;
    }
    getLoadingContent() {
        return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; worker-src 'none'; child-src 'none';">
            <title>正在翻译</title>
            <style>
                body {
                    margin: 0;
                    background: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    font-family: var(--vscode-font-family);
                }
                .loading {
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    font-size: 14px;
                    color: var(--vscode-descriptionForeground);
                }
            </style>
        </head>
        <body>
            <div class="loading">翻译中...</div>
        </body>
        </html>`;
    }
    getErrorContent(error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const errorStr = this.escapeHtml(errorMsg);
        const isKeyMissing = /还没配置|not configured/i.test(errorMsg);
        const isKeyInvalid = /无效|invalid|403|额度/i.test(errorMsg);
        let guideHtml = '';
        if (isKeyMissing) {
            guideHtml = `
                <p class="hint">在 VS Code 设置里把当前服务商的密钥填上就能用了。</p>
                <button class="action" onclick="openSettings('markdownTranslator')">去填设置</button>
            `;
        } else if (isKeyInvalid) {
            guideHtml = `
                <p class="hint">密钥可能过期、配错，或者额度用完了。</p>
                <button class="action" onclick="openSettings('markdownTranslator')">检查设置</button>
                <button class="action secondary" onclick="retry()">重试</button>
            `;
        } else {
            guideHtml = `
                <button class="action" onclick="retry()">重试</button>
                <button class="action secondary" onclick="openSettings('markdownTranslator')">检查设置</button>
            `;
        }
        return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; worker-src 'none'; child-src 'none';">
            <title>需要配置</title>
            <style>
                body {
                    margin: 0;
                    background: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    font-family: var(--vscode-font-family);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    height: 100vh;
                }
                .card {
                    max-width: 360px;
                    padding: 28px 24px;
                    text-align: center;
                }
                .icon {
                    font-size: 32px;
                    margin-bottom: 16px;
                    line-height: 1;
                }
                h2 {
                    font-size: 16px;
                    font-weight: 600;
                    margin: 0 0 8px;
                }
                .detail {
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                    margin: 0 0 6px;
                    word-break: break-word;
                }
                .hint {
                    font-size: 13px;
                    color: var(--vscode-descriptionForeground);
                    margin: 16px 0;
                    line-height: 1.5;
                }
                .action {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 8px 20px;
                    border-radius: 4px;
                    font-size: 13px;
                    cursor: pointer;
                    margin: 4px;
                    font-family: inherit;
                }
                .action:hover { opacity: 0.9; }
                .action.secondary {
                    background: var(--vscode-button-secondaryBackground, transparent);
                    color: var(--vscode-button-secondaryForeground, var(--vscode-textLink-foreground));
                    padding: 8px 12px;
                    border: 1px solid var(--vscode-panel-border);
                }
                .action.secondary:hover {
                    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground));
                    text-decoration: none;
                }
            </style>
        </head>
        <body>
            <div class="card">
                <div class="icon">${isKeyMissing ? '🔑' : '⚠'}</div>
                <h2>${isKeyMissing ? '还差一步' : '翻译没成功'}</h2>
                <p class="detail">${errorStr}</p>
                ${guideHtml}
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                function retry() {
                    vscode.postMessage({ command: 'refresh' });
                }
                function openSettings(query) {
                    vscode.postMessage({ command: 'openSettings', query: query });
                }
            </script>
        </body>
        </html>`;
    }
    getWebviewContent(originalHtml: string, translatedHtml: string, translatedMarkdown: string) {
        const cleanMarkdown = translatedMarkdown;
        const markdownSourceHtml = this.renderMarkdownSource(cleanMarkdown);
        const markdownLineCount = cleanMarkdown.split('\n').length;
        const markdownGutterWidth = Math.max(44, 18 + String(markdownLineCount).length * 10);
        const currentProvider: string = getConfigValue('provider', 'free') || 'free';
        const providerLabel = getProviderLabel(currentProvider);
        const targetLanguageLabel = getTargetLanguageLabel();
        const fileName = this.currentFileUri ? this.escapeHtml(this.getFileName(this.currentFileUri)) : '译文';
        const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; worker-src 'none'; child-src 'none';">
    <title>Markdown 中文翻译器</title>
    <style>
        * {
            -webkit-user-select: text;
            user-select: text;
            box-sizing: border-box;
        }
        body {
            font-family: var(--vscode-font-family);
            margin: 0;
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            display: flex;
            flex-direction: column;
            height: 100vh;
        }
        .header {
            flex-shrink: 0;
            position: sticky;
            top: 0;
            z-index: 100;
            background: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .toolbar {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 14px 20px 12px;
            flex-wrap: nowrap;
            overflow: visible;
        }
        .toolbar-left {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
            flex-wrap: nowrap;
            flex: 1 1 auto;
        }
        .segmented {
            display: inline-flex;
            align-items: center;
            gap: 2px;
            padding: 3px;
            border-radius: 9999px;
            background: var(--vscode-editor-inactiveSelectionBackground, var(--vscode-textBlockQuote-background));
            border: 1px solid rgba(127,127,127,0.12);
        }
        .segment-btn {
            height: 28px;
            padding: 0 14px;
            border: none;
            border-radius: 9999px;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            font-family: inherit;
            cursor: pointer;
            white-space: nowrap;
            transition: color 0.15s, background 0.15s;
        }
        .segment-btn.active {
            background: var(--vscode-button-secondaryBackground, var(--vscode-toolbar-hoverBackground));
            color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
        }
        .segment-btn:hover:not(.active) {
            color: var(--vscode-foreground);
        }
        .provider-wrap {
            position: relative;
        }
        .provider-button {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            height: 28px;
            padding: 0 12px;
            border-radius: 9999px;
            border: 1px solid rgba(127,127,127,0.12);
            background: transparent;
            color: var(--vscode-foreground);
            cursor: pointer;
            font-family: inherit;
            font-size: 12px;
            white-space: nowrap;
            transition: background 0.15s;
        }
        .provider-button:hover {
            background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.08));
        }
        .provider-button-arrow {
            font-size: 9px;
            opacity: 0.5;
        }
        .provider-menu {
            display: none;
            position: absolute;
            top: calc(100% + 6px);
            left: 0;
            background: var(--vscode-menu-background, var(--vscode-dropdown-background));
            border: 1px solid rgba(127,127,127,0.15);
            border-radius: 10px;
            padding: 4px;
            min-width: 140px;
            box-shadow: 0 8px 30px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08);
            z-index: 200;
        }
        .provider-menu.open { display: block; }
        .provider-menu-item {
            display: block;
            width: 100%;
            padding: 7px 12px;
            font-size: 12px;
            color: var(--vscode-menu-foreground, var(--vscode-foreground));
            background: none;
            border: none;
            border-radius: 6px;
            text-align: left;
            cursor: pointer;
            font-family: inherit;
            transition: background 0.1s;
        }
        .provider-menu-item:hover {
            background: var(--vscode-menu-selectionBackground, rgba(127,127,127,0.1));
            color: var(--vscode-menu-selectionForeground, var(--vscode-foreground));
        }
        .provider-menu-item.active {
            opacity: 0.4;
            pointer-events: none;
        }
        .toolbar-file {
            min-width: 0;
            flex: 1;
            display: flex;
            align-items: center;
            gap: 6px;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            white-space: nowrap;
        }
        .file-name {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            color: var(--vscode-foreground);
            font-size: 12px;
            font-weight: 500;
        }
        .file-arrow {
            flex: none;
            opacity: 0.4;
        }
        .file-target {
            flex: none;
            opacity: 0.6;
        }
        .toolbar-actions {
            display: flex;
            align-items: center;
            gap: 4px;
            flex: none;
        }
        .toolbar-btn {
            height: 28px;
            padding: 0 10px;
            border-radius: 6px;
            border: none;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            font-family: inherit;
            font-size: 12px;
            white-space: nowrap;
            transition: color 0.15s, background 0.15s;
        }
        .toolbar-btn:hover {
            color: var(--vscode-foreground);
            background: rgba(127,127,127,0.08);
        }
        .memo {
            padding: 6px 20px 8px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            opacity: 0.6;
            transition: opacity 0.3s;
        }
        .memo:empty { display: none; }
        .memo.loading, .memo.delta-loading {
            opacity: 1;
        }
        .content {
            flex: 1;
            padding: 16px 24px 28px;
            overflow-y: auto;
            line-height: var(--vscode-editor-line-height, 1.6);
            font-size: var(--vscode-editor-font-size, 14px);
        }
        .content-shell {
            width: min(880px, 100%);
            margin: 0 auto;
        }
        .view {
            display: none;
        }
        .view.active {
            display: block;
        }
        .view-preview pre {
            background: var(--vscode-textBlockQuote-background);
            padding: 14px 16px;
            border-radius: 8px;
            overflow-x: auto;
            border: 1px solid rgba(127,127,127,0.1);
            margin: 14px 0;
            line-height: 1.5;
        }
        .view-preview pre code {
            background: none;
            padding: 0;
            border-radius: 0;
            font-family: 'Courier New', monospace;
            line-height: inherit;
        }
        .view-preview code {
            background: var(--vscode-textBlockQuote-background);
            padding: 2px 6px;
            border-radius: 3px;
            font-family: 'Courier New', monospace;
        }
        .view-preview blockquote {
            border-left: 3px solid rgba(127,127,127,0.2);
            margin: 16px 0;
            padding-left: 16px;
            color: var(--vscode-descriptionForeground);
        }
        .view-preview table {
            border-collapse: collapse;
            width: 100%;
            margin: 16px 0;
        }
        .view-preview th, .view-preview td {
            border: 1px solid rgba(127,127,127,0.12);
            padding: 10px 14px;
            text-align: left;
        }
        .view-preview th {
            background: var(--vscode-textBlockQuote-background);
            font-weight: 600;
        }
        .view-preview h1, .view-preview h2, .view-preview h3, .view-preview h4, .view-preview h5, .view-preview h6 {
            margin-top: 24px;
            margin-bottom: 16px;
        }
        .view-preview p {
            margin: 16px 0;
        }
        .view-preview ul, .view-preview ol {
            margin: 16px 0;
            padding-left: 32px;
        }
        .view-preview li {
            margin: 8px 0;
        }
        .markdown-source {
            margin: 0;
            border: 1px solid rgba(127,127,127,0.1);
            border-radius: 10px;
            background: var(--vscode-editor-background);
            overflow-x: auto;
            overflow-y: hidden;
        }
        .markdown-editor {
            min-width: 100%;
            padding: 4px 0;
        }
        .markdown-line {
            display: grid;
            grid-template-columns: var(--md-gutter-width, 44px) minmax(0, 1fr);
            align-items: start;
            min-height: var(--vscode-editor-line-height, 20px);
            font-family: var(--vscode-editor-font-family, 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace);
            font-size: var(--vscode-editor-font-size, 13px);
            line-height: var(--vscode-editor-line-height, 20px);
            letter-spacing: var(--vscode-editor-letter-spacing, normal);
        }
        .markdown-line:hover {
            background: var(--vscode-editor-lineHighlightBackground, rgba(127, 127, 127, 0.06));
        }
        .markdown-line-no {
            padding: 0 8px 0 6px;
            text-align: right;
            color: var(--vscode-editorLineNumber-foreground, var(--vscode-descriptionForeground));
            user-select: none;
            font-size: var(--vscode-editor-font-size, 13px);
            line-height: var(--vscode-editor-line-height, 20px);
        }
        .markdown-line-text {
            display: block;
            min-width: 0;
            padding: 0 16px;
            white-space: pre-wrap;
            word-break: break-word;
            color: var(--vscode-editor-foreground);
        }
        .markdown-line-text.is-empty::after {
            content: ' ';
        }
        .md-token-heading-mark,
        .md-token-rule,
        .md-token-fence,
        .md-token-quote,
        .md-token-bullet {
            color: var(--vscode-editorInfo-foreground, var(--vscode-textLink-foreground));
        }
        .md-token-heading-text {
            color: var(--vscode-symbolIcon-classForeground, var(--vscode-foreground));
            font-weight: 600;
        }
        .md-token-code {
            color: var(--vscode-textPreformat-foreground, var(--vscode-terminal-ansiGreen));
        }
        .md-token-link {
            color: var(--vscode-textLink-foreground);
        }
        .md-token-strong {
            font-weight: 700;
        }
        .md-token-em {
            font-style: italic;
        }
        @media (max-width: 760px) {
            .toolbar {
                padding: 10px 14px;
            }
            .memo {
                padding: 8px 14px 10px;
            }
            .content {
                padding: 16px 14px 22px;
            }
            .toolbar-file {
                display: none;
            }
        }
        /* ---- 设置抽屉 ---- */
        .drawer-overlay {
            display: none; position: fixed; inset: 0; background: rgba(38,37,30,0.3); z-index: 900;
        }
        .drawer-overlay.open { display: block; }
        .drawer {
            position: fixed; top: 0; right: -360px; width: 340px; height: 100%; z-index: 901;
            background: var(--vscode-sideBar-background, #f2f1ed);
            border-left: 1px solid rgba(38,37,30,0.15);
            box-shadow: -8px 0 32px rgba(38,37,30,0.12);
            transition: right 0.25s ease; display: flex; flex-direction: column;
            font-family: var(--vscode-font-family, system-ui);
        }
        .drawer.open { right: 0; }
        .drawer-header {
            display: flex; justify-content: space-between; align-items: center;
            padding: 16px 20px; border-bottom: 1px solid rgba(38,37,30,0.1);
        }
        .drawer-header h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--vscode-foreground, #26251e); }
        .drawer-close {
            background: none; border: none; font-size: 18px; cursor: pointer;
            color: var(--vscode-foreground, #26251e); opacity: 0.5; padding: 4px 8px; border-radius: 4px;
        }
        .drawer-close:hover { opacity: 1; background: rgba(38,37,30,0.06); }
        .drawer-body { padding: 20px; overflow-y: auto; flex: 1; }
        .drawer-label {
            display: block; font-size: 12px; font-weight: 500; margin: 12px 0 4px;
            color: var(--vscode-foreground, #26251e); opacity: 0.7;
        }
        .drawer-label:first-child { margin-top: 0; }
        .drawer-select, .drawer-input {
            width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 13px;
            border: 1px solid rgba(38,37,30,0.15); border-radius: 6px;
            background: var(--vscode-input-background, #fff);
            color: var(--vscode-input-foreground, #26251e);
        }
        .drawer-select:focus, .drawer-input:focus { outline: none; border-color: #cf2d56; }
        .drawer-fields { margin-top: 4px; }
        .drawer-help { margin-top: 10px; }
        .drawer-help-link {
            display: inline-flex; align-items: center; padding: 0;
            border: none; background: transparent; cursor: pointer;
            font-size: 12px; color: var(--vscode-textLink-foreground, #cf2d56);
            text-decoration: none;
        }
        .drawer-help-link:hover { opacity: 0.8; }
        .drawer-actions { display: flex; gap: 8px; margin-top: 20px; }
        .drawer-btn {
            flex: 1; padding: 8px 0; font-size: 13px; border-radius: 6px; cursor: pointer;
            border: 1px solid rgba(38,37,30,0.15); font-weight: 500;
        }
        .drawer-btn-primary {
            background: #26251e; color: #f2f1ed; border-color: #26251e;
        }
        .drawer-btn-primary:hover { background: #cf2d56; border-color: #cf2d56; }
        .drawer-btn-secondary { background: transparent; color: var(--vscode-foreground, #26251e); }
        .drawer-btn-secondary:hover { background: rgba(38,37,30,0.06); }
        .drawer-status {
            margin-top: 12px; font-size: 12px; min-height: 18px;
            color: var(--vscode-foreground, #26251e); opacity: 0.7;
        }
        .drawer-status.success { color: #1f8a65; opacity: 1; }
        .drawer-status.error { color: #cf2d56; opacity: 1; }
        .drawer-footer {
            margin-top: 24px; padding-top: 16px; border-top: 1px solid rgba(38,37,30,0.1);
            display: flex; gap: 16px;
        }
        .drawer-link {
            font-size: 12px; color: var(--vscode-foreground, #26251e); opacity: 0.5;
            text-decoration: none;
        }
        .drawer-link:hover { opacity: 1; color: #cf2d56; }
    </style>
</head>
<body>
    <div class="header">
        <div class="toolbar">
            <div class="toolbar-left">
                <div class="segmented" role="tablist" aria-label="View mode">
                    <button type="button" class="segment-btn" id="previewTab" onclick="setViewMode('preview')">Preview</button>
                    <button type="button" class="segment-btn active" id="markdownTab" onclick="setViewMode('markdown')">Markdown</button>
                </div>
                <div class="provider-wrap" id="providerWrap">
                    <button type="button" class="provider-button" id="providerToggle" onclick="toggleProviderMenu(event)" aria-haspopup="menu" aria-expanded="false">
                        <span id="providerButtonLabel">${providerLabel}</span>
                        <span class="provider-button-arrow">▼</span>
                    </button>
                    <div class="provider-menu" id="providerMenu" role="menu">
                        <button type="button" class="provider-menu-item ${currentProvider === 'free' ? 'active' : ''}" data-provider="free" onclick="selectProvider(event,'free')">免费</button>
                        <button type="button" class="provider-menu-item ${currentProvider === 'volcengine' ? 'active' : ''}" data-provider="volcengine" onclick="selectProvider(event,'volcengine')">火山引擎</button>
                        <button type="button" class="provider-menu-item ${currentProvider === 'google' ? 'active' : ''}" data-provider="google" onclick="selectProvider(event,'google')">Google</button>
                    </div>
                </div>
                <div class="toolbar-file" title="${fileName} → ${targetLanguageLabel}">
                    <span class="file-name">${fileName}</span>
                    <span class="file-arrow">→</span>
                    <span class="file-target">${targetLanguageLabel}</span>
                </div>
            </div>
            <div class="toolbar-actions">
                <button type="button" class="toolbar-btn" onclick="syncTranslation()" title="按缓存同步">同步</button>
                <button type="button" class="toolbar-btn" onclick="forceRefreshTranslation()" title="忽略缓存重翻">重翻</button>
                <button type="button" class="toolbar-btn" onclick="saveTranslation()" title="导出译文">导出</button>
                <button type="button" class="toolbar-btn" onclick="openDrawer()" title="打开设置">设置</button>
            </div>
        </div>
    </div>
    <!-- 设置抽屉 -->
    <div class="drawer-overlay" id="drawerOverlay" onclick="closeDrawer()"></div>
    <aside class="drawer" id="drawer">
        <div class="drawer-header">
            <h3>设置</h3>
            <button type="button" class="drawer-close" onclick="closeDrawer()">✕</button>
        </div>
        <div class="drawer-body">
            <label class="drawer-label">翻译服务商</label>
            <select id="drawerProvider" class="drawer-select" onchange="showProviderFields()">
                <option value="free">免费</option>
                <option value="volcengine">火山引擎</option>
                <option value="google">Google</option>
            </select>
            <div id="fieldsVolcengine" class="drawer-fields" style="display:none">
                <label class="drawer-label">AccessKey ID</label>
                <input id="volcAccessKeyId" class="drawer-input" type="text" placeholder="AK..." />
                <label class="drawer-label">Secret Key</label>
                <input id="volcSecretKey" class="drawer-input" type="password" placeholder="SK..." />
                <label class="drawer-label">Region</label>
                <input id="volcRegion" class="drawer-input" type="text" value="cn-north-1" />
                <div class="drawer-help">
                    <button type="button" class="drawer-help-link" onclick="openVolcengineTutorial()">查看申请教程</button>
                </div>
            </div>
            <div id="fieldsGoogle" class="drawer-fields" style="display:none">
                <label class="drawer-label">API Key</label>
                <input id="googleApiKey" class="drawer-input" type="password" placeholder="AIza..." />
            </div>
            <div id="fieldsFree" class="drawer-fields" style="display:none">
                <label class="drawer-label">Google 镜像 (可选)</label>
                <input id="freeGoogleMirror" class="drawer-input" type="text" placeholder="https://..." />
            </div>
            <div class="drawer-actions">
                <button type="button" class="drawer-btn drawer-btn-primary" onclick="saveDrawerSettings()">保存</button>
                <button type="button" class="drawer-btn drawer-btn-secondary" onclick="testDrawerConnection()">测试连接</button>
            </div>
            <div id="drawerStatus" class="drawer-status"></div>
            <div class="drawer-footer">
                <a href="https://github.com/hiyeshu/md-translator-zh" class="drawer-link">GitHub</a>
                <a href="https://github.com/hiyeshu/md-translator-zh/issues" class="drawer-link">反馈</a>
            </div>
        </div>
    </aside>
    <div class="memo" id="memo">
        译自 ${providerLabel}
    </div>
        <div class="content">
            <div class="content-shell">
                <article class="view view-preview active" id="previewView">
                    ${translatedHtml}
                </article>
                <section class="view markdown-source" id="markdownView" style="--md-gutter-width:${markdownGutterWidth}px">
                    ${markdownSourceHtml}
                </section>
            </div>
        </div>
    <script>
        (function() {
            'use strict';
            
            var vscode;
            try {
                vscode = acquireVsCodeApi();
            } catch (e) {
                console.error('Failed to acquire VS Code API');
                return;
            }
            
            var webviewState = vscode.getState() || {};
            var viewMode = webviewState.viewMode === 'preview' ? 'preview' : 'markdown';
            var currentProvider = ${JSON.stringify(currentProvider)};
            var translatedContent = ${JSON.stringify(cleanMarkdown)};

            function persistState() {
                try {
                    vscode.setState({ viewMode: viewMode });
                } catch (e) {}
            }

            function setViewMode(nextMode) {
                viewMode = nextMode === 'markdown' ? 'markdown' : 'preview';
                var previewTab = document.getElementById('previewTab');
                var markdownTab = document.getElementById('markdownTab');
                var previewView = document.getElementById('previewView');
                var markdownView = document.getElementById('markdownView');

                if (previewTab) previewTab.classList.toggle('active', viewMode === 'preview');
                if (markdownTab) markdownTab.classList.toggle('active', viewMode === 'markdown');
                if (previewView) previewView.classList.toggle('active', viewMode === 'preview');
                if (markdownView) markdownView.classList.toggle('active', viewMode === 'markdown');
                persistState();
            }

            function saveTranslation() {
                try {
                    vscode.postMessage({ command: 'save', content: translatedContent });
                } catch (e) {}
            }

            function syncTranslation() {
                try {
                    vscode.postMessage({ command: 'refresh' });
                } catch (e) {}
            }

            function forceRefreshTranslation() {
                try {
                    vscode.postMessage({ command: 'forceRefresh' });
                } catch (e) {}
            }

            function openSettings(query) {
                try {
                    vscode.postMessage({ command: 'openSettings', query: query });
                } catch (e) {}
            }

            // ---- 设置抽屉 ----
            function openDrawer() {
                vscode.postMessage({ command: 'getSettings' });
                document.getElementById('drawerOverlay').classList.add('open');
                document.getElementById('drawer').classList.add('open');
            }
            function closeDrawer() {
                document.getElementById('drawerOverlay').classList.remove('open');
                document.getElementById('drawer').classList.remove('open');
            }
            function showProviderFields() {
                var p = document.getElementById('drawerProvider').value;
                document.getElementById('fieldsVolcengine').style.display = p === 'volcengine' ? 'block' : 'none';
                document.getElementById('fieldsGoogle').style.display = p === 'google' ? 'block' : 'none';
                document.getElementById('fieldsFree').style.display = p === 'free' ? 'block' : 'none';
            }
            function populateSettings(s) {
                document.getElementById('drawerProvider').value = s.provider || 'free';
                document.getElementById('volcAccessKeyId').value = s['volcengine.accessKeyId'] || '';
                document.getElementById('volcSecretKey').value = s['volcengine.secretKey'] || '';
                document.getElementById('volcRegion').value = s['volcengine.region'] || 'cn-north-1';
                document.getElementById('googleApiKey').value = s['google.apiKey'] || '';
                document.getElementById('freeGoogleMirror').value = s['free.googleMirror'] || '';
                showProviderFields();
            }
            function saveDrawerSettings() {
                var settings = { provider: document.getElementById('drawerProvider').value };
                var p = settings.provider;
                if (p === 'volcengine') {
                    settings['volcengine.accessKeyId'] = document.getElementById('volcAccessKeyId').value;
                    settings['volcengine.secretKey'] = document.getElementById('volcSecretKey').value;
                    settings['volcengine.region'] = document.getElementById('volcRegion').value || 'cn-north-1';
                } else if (p === 'google') {
                    settings['google.apiKey'] = document.getElementById('googleApiKey').value;
                } else {
                    settings['free.googleMirror'] = document.getElementById('freeGoogleMirror').value;
                }
                document.getElementById('drawerStatus').textContent = '保存中...';
                document.getElementById('drawerStatus').className = 'drawer-status';
                vscode.postMessage({ command: 'saveSettings', settings: settings });
            }
            function testDrawerConnection() {
                document.getElementById('drawerStatus').textContent = '测试中...';
                document.getElementById('drawerStatus').className = 'drawer-status';
                vscode.postMessage({ command: 'testConnection' });
            }
            function openVolcengineTutorial() {
                vscode.postMessage({ command: 'openExternal', url: ${JSON.stringify(VOLCENGINE_TUTORIAL_URL)} });
            }

            window.addEventListener('message', function(event) {
                var msg = event.data;
                if (msg.command === 'settingsData') { populateSettings(msg.settings); }
                if (msg.command === 'settingsSaved') {
                    var el = document.getElementById('drawerStatus');
                    el.textContent = '已保存'; el.className = 'drawer-status success';
                }
                if (msg.command === 'testResult') {
                    var el = document.getElementById('drawerStatus');
                    el.textContent = msg.message;
                    el.className = 'drawer-status ' + (msg.success ? 'success' : 'error');
                }
            });

            function closeProviderMenu() {
                var menu = document.getElementById('providerMenu');
                var toggle = document.getElementById('providerToggle');
                if (menu) menu.classList.remove('open');
                if (toggle) toggle.setAttribute('aria-expanded', 'false');
            }

            function toggleProviderMenu(event) {
                if (event) event.stopPropagation();
                var menu = document.getElementById('providerMenu');
                var toggle = document.getElementById('providerToggle');
                if (!menu) return;
                var isOpen = menu.classList.toggle('open');
                if (toggle) toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            }

            function selectProvider(event, provider) {
                event.stopPropagation();
                closeProviderMenu();
                try {
                    vscode.postMessage({ command: 'changeProvider', provider: provider });
                } catch (e) {}
            }

            function syncProvider(provider) {
                currentProvider = provider || currentProvider;
                var providerLabels = {
                    free: '免费',
                    volcengine: '火山引擎',
                    google: 'Google',
                };
                var providerName = providerLabels[currentProvider] || currentProvider;
                var providerButtonLabel = document.getElementById('providerButtonLabel');
                if (providerButtonLabel) providerButtonLabel.textContent = providerName;

                var items = document.querySelectorAll('.provider-menu-item');
                items.forEach(function(item) {
                    item.classList.toggle('active', item.getAttribute('data-provider') === currentProvider);
                });

                return providerName;
            }

            document.addEventListener('click', function(e) {
                var wrap = document.getElementById('providerWrap');
                var menu = document.getElementById('providerMenu');
                if (menu && wrap && !wrap.contains(e.target)) {
                    closeProviderMenu();
                }
            });
            
            window.addEventListener('message', function(event) {
                try {
                    var message = event.data;
                    if (!message || !message.command) return;
                    
                    if (message.command === 'save') {
                        saveTranslation();
                    } else if (message.command === 'refresh') {
                        syncTranslation();
                    } else if (message.command === 'updateMemo') {
                        updateMemo(message.provider, message.state, message.savings, message.progress);
                    }
                } catch (e) {}
            });
            
            function updateMemo(provider, state, savings, progress) {
                try {
                    var memo = document.getElementById('memo');
                    if (!memo) return;
                    var providerName = syncProvider(provider);

                    memo.className = 'memo ' + (state || '');

                    if (state === 'loading') {
                        memo.textContent = '同步中...';
                    } else if (state === 'delta-loading') {
                        var progressText = progress ? ' ' + progress : '';
                        memo.textContent = '同步改动' + progressText + '...';
                    } else if (state === 'delta-completed') {
                        memo.textContent = '已同步改动，少翻 ' + (savings || 0) + '%';
                    } else if (state === 'provider-changed') {
                        memo.textContent = '已切到 ' + providerName + '，译文待同步';
                    } else if (state === 'completed') {
                        memo.textContent = '译自 ' + providerName;
                    } else if (state === 'incremental') {
                        memo.textContent = '已同步改动';
                    } else {
                        memo.textContent = '译自 ' + providerName;
                    }
                } catch (e) {}
            }
            
            syncProvider(currentProvider);
            setViewMode(viewMode);

            window.saveTranslation = saveTranslation;
            window.syncTranslation = syncTranslation;
            window.forceRefreshTranslation = forceRefreshTranslation;
            window.openSettings = openSettings;
            window.openDrawer = openDrawer;
            window.closeDrawer = closeDrawer;
            window.showProviderFields = showProviderFields;
            window.saveDrawerSettings = saveDrawerSettings;
            window.testDrawerConnection = testDrawerConnection;
            window.openVolcengineTutorial = openVolcengineTutorial;
            window.setViewMode = setViewMode;
            window.toggleProviderMenu = toggleProviderMenu;
            window.selectProvider = selectProvider;
        })();
    </script>
</body>
</html>`;
        return html;
    }
    escapeForScript(text: string) {
        return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    }
    escapeHtml(text: string) {
        return text.replace(/[&<>"']/g, (match: string) => {
            const escapeMap: Record<string, string> = {
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;'
            };
            return escapeMap[match];
        });
    }
    renderMarkdownSource(markdown: string) {
        const lines = markdown.split('\n');
        const content = lines.map((line: string, index: number) => {
            const lineHtml = this.highlightMarkdownLine(line);
            const isEmpty = line.length === 0 ? ' is-empty' : '';
            return `
                <div class="markdown-line">
                    <span class="markdown-line-no">${index + 1}</span>
                    <span class="markdown-line-text${isEmpty}">${lineHtml}</span>
                </div>
            `;
        }).join('');
        return `<div class="markdown-editor">${content}</div>`;
    }
    highlightMarkdownLine(line: string) {
        if (!line) {
            return '';
        }
        const escaped = this.escapeHtml(line);
        const headingMatch = escaped.match(/^(#{1,6})(\s+)(.*)$/);
        if (headingMatch) {
            return `<span class="md-token-heading-mark">${headingMatch[1]}</span>${headingMatch[2]}<span class="md-token-heading-text">${headingMatch[3]}</span>`;
        }
        const quoteMatch = escaped.match(/^(\s*&gt;+\s?)(.*)$/);
        if (quoteMatch) {
            return `<span class="md-token-quote">${quoteMatch[1]}</span>${this.decorateInlineTokens(quoteMatch[2])}`;
        }
        const listMatch = escaped.match(/^(\s*)([-*+]|\d+\.)(\s+)(.*)$/);
        if (listMatch) {
            return `${listMatch[1]}<span class="md-token-bullet">${listMatch[2]}</span>${listMatch[3]}${this.decorateInlineTokens(listMatch[4])}`;
        }
        if (/^\s*(```|~~~)/.test(line)) {
            return `<span class="md-token-fence">${escaped}</span>`;
        }
        if (/^\s*([-*_]){3,}\s*$/.test(line)) {
            return `<span class="md-token-rule">${escaped}</span>`;
        }
        return this.decorateInlineTokens(escaped);
    }
    decorateInlineTokens(escapedLine: string) {
        return escapedLine
            .replace(/(`[^`]+`)/g, '<span class="md-token-code">$1</span>')
            .replace(/(\[[^\]]+\]\([^)]+\))/g, '<span class="md-token-link">$1</span>')
            .replace(/(\*\*[^*]+\*\*|__[^_]+__)/g, '<span class="md-token-strong">$1</span>')
            .replace(/(\*[^*\n]+\*|_[^_\n]+_)/g, '<span class="md-token-em">$1</span>');
    }
}

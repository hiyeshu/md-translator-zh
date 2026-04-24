"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TranslationViewerProvider = void 0;
const logger_1 = require("./logger");
const vscode = require("vscode");
const fs = require("fs");
const translationManager_1 = require("./translationManager");
const markdownProcessor_1 = require("./markdownProcessor");
const DEFAULT_TARGET_LANGUAGE = 'zh-CN';
function getProviderLabel(provider) {
    const labels = {
        google: 'Google',
        azure: 'Azure',
        custom: '自定义 API'
    };
    return labels[provider] || provider;
}
function getTargetLanguageLabel() {
    return DEFAULT_TARGET_LANGUAGE === 'zh-CN' ? '简体中文' : '繁体中文';
}
function getTargetFileSuffix() {
    return `_${DEFAULT_TARGET_LANGUAGE}`;
}
class TranslationViewerProvider {
    constructor(extensionUri, context) {
        this.extensionUri = extensionUri;
        this.context = context;
        this.markdownProcessor = new markdownProcessor_1.MarkdownProcessor();
        this.isUpdating = false;
        this.disposables = [];
        this.currentTranslatedContent = '';
        this.currentProvider = '';
        this.translationState = 'empty';
        this.currentFileContent = '';
        this.lastTranslatedNodes = [];
        this.translationManager = new translationManager_1.TranslationManager(context);
    }
    dispose() {
        this.cleanup();
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
    onFileChanged(uri) {
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
    async createOrShow(fileUri) {
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
    async autoTranslate(fileUri) {
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
                logger_1.Logger.info('Auto-translating file on open...');
                await this.updateContent(fileUri);
            }
        }
        catch (error) {
            logger_1.Logger.error('Auto-translation failed:', error);
        }
    }
    async handleWebviewMessage(message, fileUri) {
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
                default:
                    console.warn('Unknown webview message:', message.command);
            }
        }
        catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`操作失败：${errorMsg}`);
        }
    }
    async forceRefresh(fileUri) {
        // Clear file cache
        this.translationManager.clearFileCache(fileUri.fsPath);
        // Show loading state
        this.showLoadingState();
        vscode.window.showInformationMessage(`正在用 ${getProviderLabel(this.getSelectedProvider())} 重新翻译...`);
        // Force update without cache
        await this.updateContentWithoutCache(fileUri);
    }
    getSelectedProvider() {
        const config = vscode.workspace.getConfiguration('mdcarrot');
        return config.get('provider') || 'google';
    }
    async updateContentWithoutCache(fileUri) {
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
    async changeProvider(provider, fileUri) {
        const config = vscode.workspace.getConfiguration('mdcarrot');
        await config.update('provider', provider, vscode.ConfigurationTarget.Global);
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
            vscode.window.showInformationMessage(`已切到 ${providerLabel}，当前译文还没重翻。`);
            this.updateMemoOnly(provider);
        }
    }
    updateTranslationComplete(translatedMarkdown) {
        this.translationState = 'translated';
        this.currentTranslatedContent = translatedMarkdown;
        const config = vscode.workspace.getConfiguration('mdcarrot');
        const provider = config.get('provider') || 'google';
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
            const config = vscode.workspace.getConfiguration('mdcarrot');
            const currentProvider = config.get('provider') || 'google';
            this.panel.webview.postMessage({
                command: 'updateMemo',
                provider: currentProvider,
                state: 'loading'
            });
        }
    }
    detectContentDeltas(oldContent, newContent) {
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
    isSemanticBoundary(text) {
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
    calculateCost(charCount) {
        const config = vscode.workspace.getConfiguration('mdcarrot');
        const provider = config.get('provider') || 'google';
        // Cost per character by provider
        const costs = {
            'google': 0.00002,
            'azure': 0.00001,
            'custom': 0.00002
        };
        return charCount * (costs[provider] || costs.google);
    }
    updateMemoToCompleted(provider) {
        if (this.panel) {
            this.panel.webview.postMessage({
                command: 'updateMemo',
                provider: provider,
                state: 'completed'
            });
        }
    }
    updateMemoOnly(newProvider) {
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
    getFileName(uri) {
        const path = require('path');
        return path.basename(uri.fsPath) || 'Unknown';
    }
    async updateContentDelta(fileUri) {
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
                logger_1.Logger.debug('No content changes detected');
                return;
            }
            // Filter out non-semantic deltas and merge small adjacent changes
            const semanticDeltas = this.optimizeDeltas(deltas);
            if (semanticDeltas.length === 0) {
                logger_1.Logger.debug('No semantic changes detected');
                return;
            }
            // Calculate cost savings
            const totalChars = newContent.length;
            const deltaChars = semanticDeltas.reduce((sum, d) => sum + d.newText.length, 0);
            const savings = Math.round((1 - deltaChars / totalChars) * 100);
            // If savings are minimal, do full translation instead
            if (savings < 20) {
                logger_1.Logger.debug('Delta savings too small, doing full translation');
                await this.updateContent(fileUri);
                return;
            }
            logger_1.Logger.debug(`Delta translation: ${semanticDeltas.length} changes, ${deltaChars}/${totalChars} chars (${savings}% savings)`);
            // Show delta loading state with progress
            if (this.panel) {
                const config = vscode.workspace.getConfiguration('mdcarrot');
                const provider = config.get('provider') || 'google';
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
                    const config = vscode.workspace.getConfiguration('mdcarrot');
                    const provider = config.get('provider') || 'google';
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
    optimizeDeltas(deltas) {
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
    applyDeltaTranslations(content, deltas, translations) {
        const lines = content.split('\n');
        let translationIndex = 0;
        // Apply translations in reverse order to avoid index shifting
        const sortedDeltas = [...deltas].sort((a, b) => b.startIndex - a.startIndex);
        for (const delta of sortedDeltas) {
            if (translationIndex < translations.length) {
                const translation = translations[translations.length - 1 - translationIndex];
                // Replace the entire delta range with the translation
                const translationLines = translation.split('\n');
                lines.splice(delta.startIndex, delta.endIndex - delta.startIndex, ...translationLines);
                translationIndex++;
            }
        }
        return lines.join('\n');
    }
    async updateContent(fileUri) {
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
    async saveTranslation(originalUri, content) {
        if (!content || typeof content !== 'string') {
            throw new Error('Invalid content to save');
        }
        const path = require('path');
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
            <script>
                // 🔍 DEBUG LOGGING for No Content view
                console.log('[mdcarrot-debug] No Content WebView loaded');
                console.log('[mdcarrot-debug] Location:', window.location.href);
                
                // 🔥 Service Worker blocking
                if ('serviceWorker' in navigator) {
                    try {
                        Object.defineProperty(navigator, 'serviceWorker', {
                            value: {
                                register: (url) => {
                                    console.log('[mdcarrot-debug] SW blocked in No Content view:', url);
                                    return Promise.resolve(null);
                                },
                                getRegistrations: () => Promise.resolve([]),
                                getRegistration: () => Promise.resolve(null)
                            },
                            writable: false,
                            configurable: false
                        });
                        console.log('[mdcarrot-debug] SW blocking applied to No Content view');
                    } catch (e) {
                        console.log('[mdcarrot-debug] SW blocking failed in No Content view:', e.message);
                    }
                }
            </script>
            <title>没有可翻译内容</title>
            <style>
                body { 
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; 
                    margin: 20px; 
                    background: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    text-align: center;
                }
            </style>
        </head>
        <body>
            <h2>没有可翻译内容</h2>
            <p>这个 Markdown 文件里没有可翻译的正文。</p>
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
            <script>
                // 🔍 DEBUG LOGGING for Loading view
                console.log('[mdcarrot-debug] Loading WebView initialized');
                
                // 🔥 Service Worker blocking with logging
                if ('serviceWorker' in navigator) {
                    try {
                        Object.defineProperty(navigator, 'serviceWorker', {
                            value: {
                                register: (url) => {
                                    console.log('[mdcarrot-debug] SW blocked in Loading view:', url);
                                    return Promise.resolve(null);
                                },
                                getRegistrations: () => Promise.resolve([]),
                                getRegistration: () => Promise.resolve(null)
                            },
                            writable: false,
                            configurable: false
                        });
                        console.log('[mdcarrot-debug] SW blocking applied to Loading view');
                    } catch (e) {
                        console.log('[mdcarrot-debug] SW blocking failed in Loading view:', e.message);
                    }
                }
            </script>
            <title>正在翻译</title>
            <style>
                body { 
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; 
                    margin: 0; 
                    background: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                }
                .loading {
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    font-size: 18px;
                }
            </style>
        </head>
        <body>
            <div class="loading">正在生成简体中文译文...</div>
        </body>
        </html>`;
    }
    getErrorContent(error) {
        return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; worker-src 'none'; child-src 'none';">
            <script>
                // 🔍 DEBUG LOGGING for Error view
                console.log('[mdcarrot-debug] Error WebView loaded');
                
                // 🔥 Service Worker blocking with logging
                if ('serviceWorker' in navigator) {
                    try {
                        Object.defineProperty(navigator, 'serviceWorker', {
                            value: {
                                register: (url) => {
                                    console.log('[mdcarrot-debug] SW blocked in Error view:', url);
                                    return Promise.resolve(null);
                                },
                                getRegistrations: () => Promise.resolve([]),
                                getRegistration: () => Promise.resolve(null)
                            },
                            writable: false,
                            configurable: false
                        });
                        console.log('[mdcarrot-debug] SW blocking applied to Error view');
                    } catch (e) {
                        console.log('[mdcarrot-debug] SW blocking failed in Error view:', e.message);
                    }
                }
            </script>
            <title>翻译失败</title>
            <style>
                body { 
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; 
                    margin: 20px; 
                    background: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                }
                .error { color: var(--vscode-errorForeground); }
                button { 
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 8px 16px;
                    cursor: pointer;
                    margin-top: 10px;
                }
            </style>
        </head>
        <body>
            <h2 class="error">翻译失败</h2>
            <p>${this.escapeHtml(error)}</p>
            <button onclick="retry()">重试</button>
            <script>
                const vscode = acquireVsCodeApi();
                function retry() {
                    vscode.postMessage({ command: 'refresh' });
                }
            </script>
        </body>
        </html>`;
    }
    getWebviewContent(originalHtml, translatedHtml, translatedMarkdown) {
        // Don't escape the markdown for saving - keep it clean
        const cleanMarkdown = translatedMarkdown;
        const config = vscode.workspace.getConfiguration('mdcarrot');
        const currentProvider = config.get('provider') || 'google';
        const providerLabel = getProviderLabel(currentProvider);
        const targetLanguageLabel = getTargetLanguageLabel();
        const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; worker-src 'none'; child-src 'none';">
    <script>
        // 🔍 COMPREHENSIVE DEBUG LOGGING for Markdown Translator WebView
        (function() {
            'use strict';
            const log = (msg, data) => console.log('[mdzh-debug] ' + msg, data || '');
            
            // Environment detection
            log('=== Markdown Translator WebView Debug Start ===');
            log('Location:', window.location.href);
            log('User Agent:', navigator.userAgent);
            log('Protocol:', window.location.protocol);
            log('Origin:', window.location.origin);
            log('Document readyState:', document.readyState);
            log('Window top === window:', window.top === window);
            
            // VS Code API detection
            try {
                const vsCodeApi = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : null;
                log('VS Code API available:', !!vsCodeApi);
                if (vsCodeApi) log('VS Code API type:', typeof vsCodeApi);
            } catch (e) {
                log('VS Code API error:', e.message);
            }
            
            // Service Worker original state
            log('Original SW in navigator:', 'serviceWorker' in navigator);
            if ('serviceWorker' in navigator) {
                log('Original SW type:', typeof navigator.serviceWorker);
                log('Original SW register type:', typeof navigator.serviceWorker.register);
            }
            
            // 🔥 IMMEDIATE Service Worker blocking
            if ('serviceWorker' in navigator) {
                try {
                    const originalSW = navigator.serviceWorker;
                    log('Attempting to replace serviceWorker object...');
                    
                    Object.defineProperty(navigator, 'serviceWorker', {
                        value: {
                            register: function(url) {
                                log('SW registration blocked for URL:', url);
                                return Promise.resolve(null);
                            },
                            getRegistrations: function() { 
                                log('SW getRegistrations blocked');
                                return Promise.resolve([]); 
                            },
                            getRegistration: function(url) { 
                                log('SW getRegistration blocked for:', url);
                                return Promise.resolve(null); 
                            },
                            ready: Promise.resolve(null)
                        },
                        writable: false,
                        configurable: false,
                        enumerable: true
                    });
                    
                    log('ServiceWorker object replaced successfully');
                    log('New SW type:', typeof navigator.serviceWorker);
                    log('New SW register type:', typeof navigator.serviceWorker.register);
                    
                } catch (e) {
                    log('SW replacement failed, using fallback:', e.message);
                    // Fallback method
                    try {
                        navigator.serviceWorker.register = function(url) {
                            log('SW registration blocked (fallback) for URL:', url);
                            return Promise.resolve(null);
                        };
                        log('Fallback SW blocking applied');
                    } catch (fallbackError) {
                        log('Fallback SW blocking failed:', fallbackError.message);
                    }
                }
            } else {
                log('ServiceWorker not available in navigator');
            }
            
            // Test the blocking immediately
            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.register('test-immediate.js')
                    .then(result => log('Immediate test result:', result))
                    .catch(error => log('Immediate test error:', error.message));
            }
            
            log('=== Markdown Translator WebView Debug End ===');
        })();
    </script>
    <title>Markdown 中文翻译器</title>
    <style>
        * { 
            -webkit-user-select: text; 
            user-select: text; 
        }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; 
            margin: 0; 
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            display: flex;
            flex-direction: column;
            height: 100vh;
        }
        .header {
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            padding: 8px 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-shrink: 0;
            position: sticky;
            top: 0;
            z-index: 100;
        }
        .memo {
            background: var(--vscode-textBlockQuote-background);
            border-left: 3px solid var(--vscode-textBlockQuote-border);
            padding: 8px 12px;
            margin: 12px 16px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            border-radius: 3px;
        }
        .memo.loading {
            border-left-color: var(--vscode-progressBar-background);
        }
        .memo.delta-loading {
            border-left-color: var(--vscode-charts-green);
        }
        .memo.delta-completed {
            border-left-color: var(--vscode-charts-green);
        }
        .memo.completed {
            border-left-color: var(--vscode-charts-blue);
        }
        .memo.provider-changed {
            border-left-color: var(--vscode-notificationsWarningIcon-foreground);
        }
        .title {
            font-size: 13px;
            font-weight: 600;
            color: var(--vscode-foreground);
        }
        .subtitle {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 2px;
        }
        .controls {
            display: flex;
            gap: 12px;
            align-items: center;
        }
        .provider-selector {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .provider-label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        select {
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 2px;
            padding: 2px 6px;
            font-size: 11px;
            cursor: pointer;
        }
        select:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        .buttons {
            display: flex;
            gap: 8px;
        }
        .btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 4px 12px;
            border-radius: 2px;
            font-size: 11px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .content {
            flex: 1;
            padding: 20px;
            overflow-y: auto;
            line-height: 1.6;
        }
        pre {
            background: var(--vscode-textBlockQuote-background);
            padding: 12px 15px;
            border-radius: 4px;
            overflow-x: auto;
            border: 1px solid var(--vscode-panel-border);
            margin: 12px 0;
            line-height: 1.4;
        }
        pre code {
            background: none;
            padding: 0;
            border-radius: 0;
            font-family: 'Courier New', monospace;
            line-height: inherit;
        }
        code {
            background: var(--vscode-textBlockQuote-background);
            padding: 2px 6px;
            border-radius: 3px;
            font-family: 'Courier New', monospace;
        }
        blockquote {
            border-left: 4px solid var(--vscode-textBlockQuote-border);
            margin: 16px 0;
            padding-left: 16px;
            font-style: italic;
        }
        table {
            border-collapse: collapse;
            width: 100%;
            margin: 16px 0;
        }
        th, td {
            border: 1px solid var(--vscode-panel-border);
            padding: 12px;
            text-align: left;
        }
        th {
            background: var(--vscode-textBlockQuote-background);
            font-weight: bold;
        }
        h1, h2, h3, h4, h5, h6 {
            margin-top: 24px;
            margin-bottom: 16px;
        }
        p {
            margin: 16px 0;
        }
        ul, ol {
            margin: 16px 0;
            padding-left: 32px;
        }
        li {
            margin: 8px 0;
        }
    </style>
</head>
<body>
    <div class="header">
        <div>
            <div class="title">中文翻译</div>
            <div class="subtitle">输出：${targetLanguageLabel}</div>
        </div>
        <div class="controls">
            <div class="provider-selector">
                <span class="provider-label">服务:</span>
                <select id="providerSelect" onchange="changeProvider()">
                    <option value="google" ${currentProvider === 'google' ? 'selected' : ''}>Google</option>
                    <option value="azure" ${currentProvider === 'azure' ? 'selected' : ''}>Azure</option>
                    <option value="custom" ${currentProvider === 'custom' ? 'selected' : ''}>自定义 API</option>
                </select>
            </div>
            <div class="buttons">
                <button class="btn" onclick="saveTranslation()">
                    <span>💾</span> 导出译文
                </button>
                <button class="btn" onclick="refreshTranslation()">
                    <span>🔄</span> 重新翻译
                </button>
            </div>
        </div>
    </div>
    <div class="memo" id="memo">
        📝 当前译文来自 <strong>${providerLabel}</strong>
    </div>
    <div class="content">
        ${translatedHtml}
    </div>
    <script>
        // Minimal script - no external API access, no service worker interaction
        (function() {
            'use strict';
            
            var vscode;
            try {
                vscode = acquireVsCodeApi();
            } catch (e) {
                console.error('Failed to acquire VS Code API');
                return;
            }
            
            var translatedContent = ${JSON.stringify(cleanMarkdown)};
            
            function saveTranslation() {
                try {
                    vscode.postMessage({ command: 'save', content: translatedContent });
                } catch (e) {}
            }
            
            function refreshTranslation() {
                try {
                    vscode.postMessage({ command: 'forceRefresh' });
                } catch (e) {}
            }
            
            function changeProvider() {
                try {
                    var select = document.getElementById('providerSelect');
                    if (!select) return;
                    var newProvider = select.value;
                    vscode.postMessage({ command: 'changeProvider', provider: newProvider });
                } catch (e) {}
            }
            
            // Simple message handling
            window.addEventListener('message', function(event) {
                try {
                    var message = event.data;
                    if (!message || !message.command) return;
                    
                    if (message.command === 'save') {
                        saveTranslation();
                    } else if (message.command === 'refresh') {
                        refreshTranslation();
                    } else if (message.command === 'updateMemo') {
                        updateMemo(message.provider, message.state, message.savings, message.progress);
                    }
                } catch (e) {}
            });
            
            function updateMemo(provider, state, savings, progress) {
                try {
                    var memo = document.getElementById('memo');
                    if (!memo) return;
                    var providerLabels = {
                        google: 'Google',
                        azure: 'Azure',
                        custom: '自定义 API'
                    };
                    var providerName = providerLabels[provider] || provider;
                    
                    memo.className = 'memo ' + (state || '');
                    
                    if (state === 'loading') {
                        memo.innerHTML = '⏳ 正在用 <strong>' + providerName + '</strong> 翻译...';
                    } else if (state === 'delta-loading') {
                        var progressText = progress ? ' (' + progress + ')' : '';
                        memo.innerHTML = '⚡ 只翻改动内容，省 ' + (savings || 0) + '% 成本' + progressText + '...';
                    } else if (state === 'delta-completed') {
                        memo.innerHTML = '💰 已用 <strong>' + providerName + '</strong> 更新改动内容，省 ' + (savings || 0) + '% 成本';
                    } else if (state === 'provider-changed') {
                        memo.innerHTML = '⚠️ 已切到 <strong>' + providerName + '</strong>，当前译文还没重翻。';
                    } else if (state === 'completed') {
                        memo.innerHTML = '📝 当前译文来自 <strong>' + providerName + '</strong>';
                    } else if (state === 'incremental') {
                        memo.innerHTML = '💰 已用 <strong>' + providerName + '</strong> 只更新改动内容';
                    } else {
                        memo.innerHTML = '📝 当前译文来自 <strong>' + providerName + '</strong>';
                    }
                } catch (e) {}
            }
            
            // Make functions globally available
            window.saveTranslation = saveTranslation;
            window.refreshTranslation = refreshTranslation;
            window.changeProvider = changeProvider;
        })();
    </script>
</body>
</html>`;
        return html;
    }
    escapeForScript(text) {
        return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    }
    escapeHtml(text) {
        return text.replace(/[&<>"']/g, (match) => {
            const escapeMap = {
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;'
            };
            return escapeMap[match];
        });
    }
}
exports.TranslationViewerProvider = TranslationViewerProvider;
TranslationViewerProvider.DEBOUNCE_DELAY = 1000;
//# sourceMappingURL=translationViewer.js.map

// @ts-nocheck
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TranslationViewerProvider = void 0;
const logger_1 = require("./logger");
const vscode = require("vscode");
const fs = require("fs");
const translationManager_1 = require("./translationManager");
const markdownProcessor_1 = require("./markdownProcessor");
const config_1 = require("./config");
const DEFAULT_TARGET_LANGUAGE = 'zh-CN';
function getProviderLabel(provider) {
    const labels = {
        free: '免费',
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
                case 'openSettings':
                    vscode.commands.executeCommand('workbench.action.openSettings', message.query || 'markdownTranslator');
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
        return (0, config_1.getConfigValue)('provider', 'free') || 'free';
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
        await (0, config_1.updateConfigValue)('provider', provider, vscode.ConfigurationTarget.Global);
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
    updateTranslationComplete(translatedMarkdown) {
        this.translationState = 'translated';
        this.currentTranslatedContent = translatedMarkdown;
        const provider = (0, config_1.getConfigValue)('provider', 'free') || 'free';
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
            const currentProvider = (0, config_1.getConfigValue)('provider', 'free') || 'free';
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
        const provider = (0, config_1.getConfigValue)('provider', 'free') || 'free';
        // Cost per character by provider
        const costs = {
            'free': 0,
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
                const provider = (0, config_1.getConfigValue)('provider', 'free') || 'free';
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
                    const provider = (0, config_1.getConfigValue)('provider', 'free') || 'free';
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
    getErrorContent(error) {
        const errorStr = this.escapeHtml(error);
        const isKeyMissing = /还没配置|not configured/i.test(error);
        const isKeyInvalid = /无效|invalid|403|额度/i.test(error);
        const isCustom = /自定义/i.test(error);
        let guideHtml = '';
        if (isKeyMissing && isCustom) {
            guideHtml = `
                <p class="hint">在 VS Code 设置里填入你的 API 地址就行。</p>
                <button class="action" onclick="openSettings('markdownTranslator.custom.endpoint')">填写 API 地址</button>
            `;
        } else if (isKeyMissing) {
            guideHtml = `
                <p class="hint">在 VS Code 设置里填入 API Key 就能用了。</p>
                <button class="action" onclick="openSettings('markdownTranslator')">去填 Key</button>
            `;
        } else if (isKeyInvalid) {
            guideHtml = `
                <p class="hint">Key 可能过期或额度用完了，检查一下？</p>
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
    getWebviewContent(originalHtml, translatedHtml, translatedMarkdown) {
        const cleanMarkdown = translatedMarkdown;
        const markdownSourceHtml = this.renderMarkdownSource(cleanMarkdown);
        const markdownLineCount = cleanMarkdown.split('\n').length;
        const markdownGutterWidth = Math.max(44, 18 + String(markdownLineCount).length * 10);
        const currentProvider = (0, config_1.getConfigValue)('provider', 'free') || 'free';
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
            gap: 12px;
            padding: 12px 20px 10px;
            flex-wrap: nowrap;
        }
        .toolbar-left {
            display: flex;
            align-items: center;
            gap: 10px;
            min-width: 0;
            flex-wrap: nowrap;
            flex: 1 1 auto;
        }
        .segmented {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 3px;
            border-radius: 10px;
            background: var(--vscode-editor-inactiveSelectionBackground, var(--vscode-textBlockQuote-background));
            border: 1px solid var(--vscode-panel-border);
        }
        .segment-btn {
            height: 30px;
            padding: 0 12px;
            border: none;
            border-radius: 8px;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            font-family: inherit;
            cursor: pointer;
            white-space: nowrap;
        }
        .segment-btn.active {
            background: var(--vscode-button-secondaryBackground, var(--vscode-toolbar-hoverBackground));
            color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
        }
        .segment-btn:hover {
            color: var(--vscode-foreground);
        }
        .provider-wrap {
            position: relative;
            flex: none;
            z-index: 2;
        }
        .provider-button {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            height: 36px;
            padding: 0 12px;
            border-radius: 10px;
            border: 1px solid var(--vscode-panel-border);
            background: var(--vscode-editor-background);
            color: var(--vscode-foreground);
            cursor: pointer;
            font-family: inherit;
            font-size: 12px;
            white-space: nowrap;
        }
        .provider-button:hover,
        .toolbar-btn:hover {
            background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
        }
        .provider-button-prefix {
            color: var(--vscode-descriptionForeground);
        }
        .provider-button-arrow {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
        }
        .provider-menu {
            display: none;
            position: absolute;
            top: calc(100% + 4px);
            left: 0;
            background: var(--vscode-menu-background, var(--vscode-dropdown-background));
            border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
            border-radius: 6px;
            padding: 4px 0;
            min-width: 160px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            z-index: 200;
        }
        .provider-menu.open { display: block; }
        .provider-menu-item {
            display: block;
            width: 100%;
            min-width: 160px;
            padding: 6px 12px;
            font-size: 12px;
            color: var(--vscode-menu-foreground, var(--vscode-foreground));
            background: none;
            border: none;
            text-align: left;
            cursor: pointer;
            font-family: inherit;
        }
        .provider-menu-item:hover {
            background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
            color: var(--vscode-menu-selectionForeground, var(--vscode-foreground));
        }
        .provider-menu-item.active {
            opacity: 0.5;
            pointer-events: none;
        }
        .toolbar-file {
            min-width: 0;
            flex: 1;
            display: flex;
            align-items: center;
            gap: 8px;
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
            font-weight: 600;
        }
        .file-arrow {
            flex: none;
            opacity: 0.6;
        }
        .file-target {
            flex: none;
        }
        .toolbar-actions {
            display: flex;
            align-items: center;
            gap: 8px;
            flex: none;
        }
        .toolbar-btn {
            height: 32px;
            padding: 0 12px;
            border-radius: 8px;
            border: 1px solid transparent;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            font-family: inherit;
            font-size: 12px;
            white-space: nowrap;
        }
        .toolbar-btn:hover {
            color: var(--vscode-foreground);
        }
        .memo {
            padding: 8px 20px 10px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            opacity: 0.7;
            transition: opacity 0.3s;
            border-top: 1px solid rgba(127, 127, 127, 0.08);
        }
        .memo.loading, .memo.delta-loading {
            opacity: 1;
        }
        .content {
            flex: 1;
            padding: 20px 24px 28px;
            overflow-y: auto;
            line-height: 1.6;
        }
        .content-shell {
            width: min(920px, 100%);
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
            padding: 12px 15px;
            border-radius: 4px;
            overflow-x: auto;
            border: 1px solid var(--vscode-panel-border);
            margin: 12px 0;
            line-height: 1.4;
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
            border-left: 4px solid var(--vscode-textBlockQuote-border);
            margin: 16px 0;
            padding-left: 16px;
            font-style: italic;
        }
        .view-preview table {
            border-collapse: collapse;
            width: 100%;
            margin: 16px 0;
        }
        .view-preview th, .view-preview td {
            border: 1px solid var(--vscode-panel-border);
            padding: 12px;
            text-align: left;
        }
        .view-preview th {
            background: var(--vscode-textBlockQuote-background);
            font-weight: bold;
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
            border: 1px solid var(--vscode-panel-border);
            border-radius: 12px;
            background: var(--vscode-editor-background);
            overflow-x: auto;
            overflow-y: hidden;
        }
        .markdown-editor {
            min-width: 100%;
            padding: 8px 0;
        }
        .markdown-line {
            display: grid;
            grid-template-columns: var(--md-gutter-width, 44px) minmax(0, 1fr);
            align-items: start;
            min-height: 24px;
            font-family: var(--vscode-editor-font-family, 'SFMono-Regular', Consolas, monospace);
            font-size: 13px;
            line-height: 1.75;
        }
        .markdown-line:hover {
            background: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.08));
        }
        .markdown-line-no {
            padding: 0 8px 0 6px;
            text-align: right;
            color: var(--vscode-editorLineNumber-foreground, var(--vscode-descriptionForeground));
            user-select: none;
            background: var(--vscode-sideBar-background, var(--vscode-editor-background));
            border-right: 1px solid rgba(127, 127, 127, 0.14);
        }
        .markdown-line-text {
            display: block;
            min-width: 0;
            padding: 0 20px 0 16px;
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
            color: var(--vscode-symbolIcon-keywordForeground, var(--vscode-textLink-foreground));
        }
        .md-token-heading-text {
            color: var(--vscode-textPreformat-foreground, var(--vscode-foreground));
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
    </style>
</head>
<body>
    <div class="header">
        <div class="toolbar">
            <div class="toolbar-left">
                <div class="segmented" role="tablist" aria-label="View mode">
                    <button type="button" class="segment-btn active" id="previewTab" onclick="setViewMode('preview')">Preview</button>
                    <button type="button" class="segment-btn" id="markdownTab" onclick="setViewMode('markdown')">Markdown</button>
                </div>
                <div class="provider-wrap" id="providerWrap">
                    <button type="button" class="provider-button" id="providerToggle" onclick="toggleProviderMenu(event)" aria-haspopup="menu" aria-expanded="false">
                        <span id="providerButtonLabel">${providerLabel}</span>
                        <span class="provider-button-arrow">▼</span>
                    </button>
                    <div class="provider-menu" id="providerMenu" role="menu">
                        <button type="button" class="provider-menu-item ${currentProvider === 'free' ? 'active' : ''}" data-provider="free" onclick="selectProvider(event,'free')">免费</button>
                        <button type="button" class="provider-menu-item ${currentProvider === 'google' ? 'active' : ''}" data-provider="google" onclick="selectProvider(event,'google')">Google</button>
                        <button type="button" class="provider-menu-item ${currentProvider === 'azure' ? 'active' : ''}" data-provider="azure" onclick="selectProvider(event,'azure')">Azure</button>
                        <button type="button" class="provider-menu-item ${currentProvider === 'custom' ? 'active' : ''}" data-provider="custom" onclick="selectProvider(event,'custom')">自定义 API</button>
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
                <button type="button" class="toolbar-btn" onclick="openSettings('markdownTranslator')" title="打开设置">设置</button>
            </div>
        </div>
    </div>
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
            var viewMode = webviewState.viewMode === 'markdown' ? 'markdown' : 'preview';
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
                    google: 'Google',
                    azure: 'Azure',
                    custom: '自定义 API'
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
            window.setViewMode = setViewMode;
            window.toggleProviderMenu = toggleProviderMenu;
            window.selectProvider = selectProvider;
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
    renderMarkdownSource(markdown) {
        const lines = markdown.split('\n');
        const content = lines.map((line, index) => {
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
    highlightMarkdownLine(line) {
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
    decorateInlineTokens(escapedLine) {
        return escapedLine
            .replace(/(`[^`]+`)/g, '<span class="md-token-code">$1</span>')
            .replace(/(\[[^\]]+\]\([^)]+\))/g, '<span class="md-token-link">$1</span>')
            .replace(/(\*\*[^*]+\*\*|__[^_]+__)/g, '<span class="md-token-strong">$1</span>')
            .replace(/(\*[^*\n]+\*|_[^_\n]+_)/g, '<span class="md-token-em">$1</span>');
    }
}
exports.TranslationViewerProvider = TranslationViewerProvider;
TranslationViewerProvider.DEBOUNCE_DELAY = 1000;

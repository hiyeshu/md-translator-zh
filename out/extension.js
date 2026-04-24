"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = require("vscode");
const logger_1 = require("./logger");
let translationViewerProvider = null;
// Constants for better maintainability
const MARKDOWN_EXTENSIONS = ['.md', '.markdown'];
const MARKDOWN_GLOB_PATTERN = '**/*.{md,markdown}';
const EXCLUDE_PATTERN = '**/node_modules/**';
const MAX_SEARCH_FILES = 10;
/**
 * Check if a file is a markdown file based on its extension
 */
function isMarkdownFile(uri) {
    const filePath = uri.fsPath.toLowerCase();
    return MARKDOWN_EXTENSIONS.some(ext => filePath.endsWith(ext));
}
/**
 * Find the target markdown file using priority-based detection
 */
// Track the most recently active markdown file
let lastActiveMarkdownFile = null;
// Setup tracking for active markdown files
function setupMarkdownFileTracking(context) {
    // Track when active editor changes
    const onDidChangeActiveTextEditor = vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && isMarkdownFile(editor.document.uri)) {
            lastActiveMarkdownFile = editor.document.uri;
            logger_1.Logger.info(`Tracked active markdown: ${editor.document.uri.fsPath}`);
        }
    });
    // Track when documents are opened
    const onDidOpenTextDocument = vscode.workspace.onDidOpenTextDocument((document) => {
        if (isMarkdownFile(document.uri)) {
            lastActiveMarkdownFile = document.uri;
            logger_1.Logger.info(`Tracked opened markdown: ${document.uri.fsPath}`);
        }
    });
    context.subscriptions.push(onDidChangeActiveTextEditor, onDidOpenTextDocument);
}
async function findTargetMarkdownFile(uri, selectedUris) {
    logger_1.Logger.info('=== FILE DETECTION DEBUG ===');
    logger_1.Logger.info(`Context URI: ${uri ? uri.fsPath : 'null'}`);
    logger_1.Logger.info(`Selected URIs count: ${selectedUris?.length || 0}`);
    logger_1.Logger.info(`Last active markdown: ${lastActiveMarkdownFile ? lastActiveMarkdownFile.fsPath : 'null'}`);
    // Priority 1: Context menu URI (right-clicked file)
    if (uri && isMarkdownFile(uri)) {
        logger_1.Logger.info(`✅ Using context URI: ${uri.fsPath}`);
        return uri;
    }
    // Priority 2: Selected URIs from Explorer (from context menu)
    if (selectedUris?.length) {
        const markdownUri = selectedUris.find(isMarkdownFile);
        if (markdownUri) {
            logger_1.Logger.info(`✅ Using selected file from Explorer: ${markdownUri.fsPath}`);
            return markdownUri;
        }
    }
    // Priority 3: Last active markdown file (tracks clicks/opens)
    if (lastActiveMarkdownFile) {
        try {
            await vscode.workspace.fs.stat(lastActiveMarkdownFile);
            logger_1.Logger.info(`✅ Using last active markdown: ${lastActiveMarkdownFile.fsPath}`);
            vscode.window.showInformationMessage(`Using recent file: ${vscode.workspace.asRelativePath(lastActiveMarkdownFile)}`);
            return lastActiveMarkdownFile;
        }
        catch {
            logger_1.Logger.info('❌ Last active markdown no longer exists');
            lastActiveMarkdownFile = null;
        }
    }
    // Priority 4: Current active editor
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && isMarkdownFile(activeEditor.document.uri)) {
        logger_1.Logger.info(`✅ Using current active editor: ${activeEditor.document.uri.fsPath}`);
        return activeEditor.document.uri;
    }
    logger_1.Logger.info('❌ No markdown files found');
    return null;
}
function activate(context) {
    // Initialize logger with output channel
    logger_1.Logger.initialize();
    logger_1.Logger.info('🚀 Markdown 中文翻译器: Starting activation...');
    // Show immediate activation confirmation
    vscode.window.showInformationMessage('Markdown 中文翻译器已激活');
    // Setup markdown file tracking (proper VS Code pattern)
    setupMarkdownFileTracking(context);
    const openViewer = vscode.commands.registerCommand('mdcarrot.openViewer', async (uri, selectedUris) => {
        try {
            logger_1.Logger.info('🔍 Command triggered - mdcarrot.openViewer');
            logger_1.Logger.info(`📁 URI parameter: ${uri ? uri.fsPath : 'undefined'}`);
            logger_1.Logger.info(`📂 Selected URIs: ${selectedUris?.length || 0} files`);
            // Show command execution confirmation
            vscode.window.showInformationMessage('Markdown 中文翻译器已打开');
            // Strict validation: Only work with markdown files
            if (uri && !isMarkdownFile(uri)) {
                logger_1.Logger.info(`❌ Ignoring non-markdown file: ${uri.fsPath}`);
                vscode.window.showWarningMessage('Markdown 中文翻译器只支持 .md 和 .markdown 文件');
                return;
            }
            // Find target markdown file
            logger_1.Logger.info('🔎 Finding target markdown file...');
            const targetUri = await findTargetMarkdownFile(uri, selectedUris);
            if (!targetUri) {
                logger_1.Logger.info('❌ No target markdown file found');
                vscode.window.showWarningMessage('Please select a markdown file (.md or .markdown) in the Explorer panel, then try again.');
                return;
            }
            logger_1.Logger.info(`✅ Target file found: ${targetUri.fsPath}`);
            // Validate file type (double-check)
            if (!isMarkdownFile(targetUri)) {
                logger_1.Logger.error(`❌ File validation failed: ${targetUri.fsPath}`);
                vscode.window.showErrorMessage('Selected file is not a markdown file. Please select a .md or .markdown file.');
                return;
            }
            // Show before loading provider
            vscode.window.showInformationMessage('Loading translation provider...');
            // Lazy load and create viewer
            logger_1.Logger.info('📦 Loading TranslationViewerProvider...');
            if (!translationViewerProvider) {
                try {
                    const { TranslationViewerProvider } = await Promise.resolve().then(() => require('./translationViewer'));
                    logger_1.Logger.info('✅ TranslationViewerProvider imported successfully');
                    translationViewerProvider = new TranslationViewerProvider(context.extensionUri, context);
                    logger_1.Logger.info('✅ TranslationViewerProvider instantiated');
                }
                catch (importError) {
                    logger_1.Logger.error('❌ Failed to import TranslationViewerProvider', importError);
                    vscode.window.showErrorMessage(`Failed to load provider: ${importError}`);
                    throw importError;
                }
            }
            logger_1.Logger.info('🎬 Creating or showing viewer...');
            vscode.window.showInformationMessage('Creating webview...');
            await translationViewerProvider.createOrShow(targetUri);
            logger_1.Logger.info('✅ Viewer created/shown successfully');
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            logger_1.Logger.error('💥 Failed to open translation viewer', error);
            vscode.window.showErrorMessage(`打开 Markdown 中文翻译器失败：${errorMessage}`);
        }
    });
    context.subscriptions.push(openViewer);
    logger_1.Logger.info('✅ Markdown 中文翻译器: Activation complete - command registered');
}
exports.activate = activate;
function deactivate() {
    logger_1.Logger.info('Markdown 中文翻译器: Extension deactivated');
    translationViewerProvider?.dispose();
    translationViewerProvider = null;
    logger_1.Logger.dispose();
}
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map

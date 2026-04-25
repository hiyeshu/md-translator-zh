import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { Logger } from './logger';
import { TextNode } from './markdownProcessor';

interface TextCacheEntry {
    originalText: string;
    translatedText: string;
    provider: string;
    timestamp: number;
    contentHash: string;
    version: string;
}

interface FileCacheEntry {
    fileHash: string;
    provider: string;
    translatedNodes: TextNode[];
    timestamp: number;
    version: string;
}

export class TranslationCache {
    private textCache = new Map<string, TextCacheEntry>();
    private fileCache = new Map<string, FileCacheEntry>();
    private readonly CURRENT_VERSION = '1.3.0';
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.checkVersionAndPurgeCache();
        this.loadCache();
    }

    private checkVersionAndPurgeCache(): void {
        const lastVersion = this.context.globalState.get<string>('cacheVersion');
        if (!lastVersion || lastVersion !== this.CURRENT_VERSION) {
            Logger.debug(`Extension upgraded from ${lastVersion || 'unknown'} to ${this.CURRENT_VERSION}, purging cache`);
            this.context.globalState.update('textCache', undefined);
            this.context.globalState.update('fileCache', undefined);
            this.context.globalState.update('cacheVersion', this.CURRENT_VERSION);
            vscode.window.showInformationMessage(`Markdown 中文翻译器已更新到 v${this.CURRENT_VERSION}，缓存已清空。`);
        }
    }

    private createHash(text: string): string {
        return crypto.createHash('md5').update(text).digest('hex');
    }
    private createFileHash(content: string, provider: string): string {
        return crypto.createHash('md5').update(content + provider).digest('hex');
    }

    isFileCached(filePath: string, content: string, provider: string): boolean {
        const cached = this.fileCache.get(filePath);
        if (!cached) return false;
        const currentHash = this.createFileHash(content, provider);
        return cached.fileHash === currentHash && cached.provider === provider;
    }

    getCachedFileTranslation(filePath: string): TextNode[] | null {
        const cached = this.fileCache.get(filePath);
        if (cached) {
            if (!cached.version || cached.version !== this.CURRENT_VERSION) {
                Logger.debug(`Invalidating cached file translation due to version mismatch: ${cached.version} vs ${this.CURRENT_VERSION}`);
                this.fileCache.delete(filePath);
                return null;
            }
            return cached.translatedNodes;
        }
        return null;
    }

    cacheFileTranslation(filePath: string, content: string, provider: string, translatedNodes: TextNode[]): void {
        const fileHash = this.createFileHash(content, provider);
        this.fileCache.set(filePath, { fileHash, provider, translatedNodes, timestamp: Date.now(), version: this.CURRENT_VERSION });
        this.saveCache();
    }

    isCached(text: string, provider: string): boolean {
        const hash = this.createHash(text + provider);
        const cached = this.textCache.get(hash);
        if (!cached) return false;
        return cached.originalText === text && cached.provider === provider;
    }

    getCached(text: string, provider: string): string | null {
        const hash = this.createHash(text + provider);
        const cached = this.textCache.get(hash);
        if (cached && cached.originalText === text && cached.provider === provider) {
            if (!cached.version || cached.version !== this.CURRENT_VERSION) {
                Logger.debug(`Invalidating cached translation due to version mismatch: ${cached.version} vs ${this.CURRENT_VERSION}`);
                this.textCache.delete(hash);
                return null;
            }
            return cached.translatedText;
        }
        return null;
    }

    cache(originalText: string, translatedText: string, provider: string): void {
        const hash = this.createHash(originalText + provider);
        const contentHash = this.createHash(originalText);
        this.textCache.set(hash, { originalText, translatedText, provider, timestamp: Date.now(), contentHash, version: this.CURRENT_VERSION });
        this.saveCache();
    }
    getBatchCached(texts: string[], provider: string): Map<string, string> {
        const results = new Map<string, string>();
        for (const text of texts) {
            const cached = this.getCached(text, provider);
            if (cached) { results.set(text, cached); }
        }
        return results;
    }

    getUncachedTexts(texts: string[], provider: string): string[] {
        return texts.filter(text => !this.isCached(text, provider));
    }

    clearAllCache(): void {
        this.textCache.clear();
        this.fileCache.clear();
        this.context.globalState.update('textCache', undefined);
        this.context.globalState.update('fileCache', undefined);
        Logger.debug('All translation cache cleared');
    }

    clearFileCache(filePath: string): void {
        this.fileCache.delete(filePath);
        this.saveCache();
    }

    clearTextCache(texts: string[], provider: string): void {
        for (const text of texts) {
            this.textCache.delete(this.createHash(text + provider));
        }
        this.saveCache();
    }

    clearProviderCache(provider: string): void {
        for (const [key, entry] of this.textCache.entries()) {
            if (entry.provider === provider) this.textCache.delete(key);
        }
        for (const [key, entry] of this.fileCache.entries()) {
            if (entry.provider === provider) this.fileCache.delete(key);
        }
        this.saveCache();
    }

    clearAll(): void {
        this.textCache.clear();
        this.fileCache.clear();
        this.saveCache();
    }

    private cleanOldEntries(): void {
        const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
        for (const [key, entry] of this.textCache.entries()) {
            if (entry.timestamp < thirtyDaysAgo) this.textCache.delete(key);
        }
        for (const [key, entry] of this.fileCache.entries()) {
            if (entry.timestamp < thirtyDaysAgo) this.fileCache.delete(key);
        }
        this.saveCache();
    }

    private loadCache(): void {
        try {
            const textCacheData = this.context.globalState.get<[string, TextCacheEntry][]>('translationTextCache', []);
            const fileCacheData = this.context.globalState.get<[string, FileCacheEntry][]>('translationFileCache', []);
            this.textCache = new Map(textCacheData);
            this.fileCache = new Map(fileCacheData);
            this.cleanOldEntries();
        } catch {
            this.textCache.clear();
            this.fileCache.clear();
        }
    }

    private saveCache(): void {
        try {
            this.context.globalState.update('translationTextCache', Array.from(this.textCache.entries()));
            this.context.globalState.update('translationFileCache', Array.from(this.fileCache.entries()));
        } catch {
            // silent
        }
    }

    getStats(): { textEntries: number; fileEntries: number; providers: string[] } {
        const providers = new Set<string>();
        for (const entry of this.textCache.values()) providers.add(entry.provider);
        for (const entry of this.fileCache.values()) providers.add(entry.provider);
        return { textEntries: this.textCache.size, fileEntries: this.fileCache.size, providers: Array.from(providers) };
    }
}
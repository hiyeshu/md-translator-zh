// @ts-nocheck
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TranslationCache = void 0;
const logger_1 = require("./logger");
const vscode = require("vscode");
const crypto = require("crypto");
class TranslationCache {
    constructor(context) {
        this.textCache = new Map();
        this.fileCache = new Map();
        this.CURRENT_VERSION = '1.3.0';
        this.context = context;
        this.checkVersionAndPurgeCache();
        this.loadCache();
    }
    checkVersionAndPurgeCache() {
        const lastVersion = this.context.globalState.get('cacheVersion');
        if (!lastVersion || lastVersion !== this.CURRENT_VERSION) {
            logger_1.Logger.debug(`Extension upgraded from ${lastVersion || 'unknown'} to ${this.CURRENT_VERSION}, purging cache`);
            // Clear all cached data
            this.context.globalState.update('textCache', undefined);
            this.context.globalState.update('fileCache', undefined);
            // Update version
            this.context.globalState.update('cacheVersion', this.CURRENT_VERSION);
            vscode.window.showInformationMessage(`Markdown 中文翻译器已更新到 v${this.CURRENT_VERSION}，缓存已清空。`);
        }
    }
    createHash(text) {
        return crypto.createHash('md5').update(text).digest('hex');
    }
    createFileHash(content, provider) {
        return crypto.createHash('md5').update(content + provider).digest('hex');
    }
    // Check if file translation is cached and still valid
    isFileCached(filePath, content, provider) {
        const cacheKey = filePath;
        const cached = this.fileCache.get(cacheKey);
        if (!cached)
            return false;
        const currentHash = this.createFileHash(content, provider);
        return cached.fileHash === currentHash && cached.provider === provider;
    }
    // Get cached file translation with version validation
    getCachedFileTranslation(filePath) {
        const cached = this.fileCache.get(filePath);
        if (cached) {
            // Check version compatibility
            if (!cached.version || cached.version !== this.CURRENT_VERSION) {
                logger_1.Logger.debug(`Invalidating cached file translation due to version mismatch: ${cached.version} vs ${this.CURRENT_VERSION}`);
                this.fileCache.delete(filePath);
                return null;
            }
            return cached.translatedNodes;
        }
        return null;
    }
    // Cache file translation
    cacheFileTranslation(filePath, content, provider, translatedNodes) {
        const fileHash = this.createFileHash(content, provider);
        this.fileCache.set(filePath, {
            fileHash,
            provider,
            translatedNodes,
            timestamp: Date.now(),
            version: this.CURRENT_VERSION
        });
        this.saveCache();
    }
    // Check if individual text is cached
    isCached(text, provider) {
        const hash = this.createHash(text + provider);
        const cached = this.textCache.get(hash);
        if (!cached)
            return false;
        // Cache is valid if text and provider match
        return cached.originalText === text && cached.provider === provider;
    }
    // Get cached translation with version validation
    getCached(text, provider) {
        const hash = this.createHash(text + provider);
        const cached = this.textCache.get(hash);
        if (cached && cached.originalText === text && cached.provider === provider) {
            // Check version compatibility
            if (!cached.version || cached.version !== this.CURRENT_VERSION) {
                logger_1.Logger.debug(`Invalidating cached translation due to version mismatch: ${cached.version} vs ${this.CURRENT_VERSION}`);
                this.textCache.delete(hash);
                return null;
            }
            return cached.translatedText;
        }
        return null;
    }
    // Cache translation
    cache(originalText, translatedText, provider) {
        const hash = this.createHash(originalText + provider);
        const contentHash = this.createHash(originalText);
        this.textCache.set(hash, {
            originalText,
            translatedText,
            provider,
            timestamp: Date.now(),
            contentHash,
            version: this.CURRENT_VERSION
        });
        this.saveCache();
    }
    // Batch check for cached translations
    getBatchCached(texts, provider) {
        const results = new Map();
        for (const text of texts) {
            const cached = this.getCached(text, provider);
            if (cached) {
                results.set(text, cached);
            }
        }
        return results;
    }
    // Get only uncached texts for batch translation
    getUncachedTexts(texts, provider) {
        return texts.filter(text => !this.isCached(text, provider));
    }
    // Clear all cache (for testing/debugging)
    clearAllCache() {
        this.textCache.clear();
        this.fileCache.clear();
        this.context.globalState.update('textCache', undefined);
        this.context.globalState.update('fileCache', undefined);
        logger_1.Logger.debug('All translation cache cleared');
    }
    // Clear cache for specific file
    clearFileCache(filePath) {
        this.fileCache.delete(filePath);
        this.saveCache();
    }
    // Clear cache for specific texts
    clearTextCache(texts, provider) {
        for (const text of texts) {
            const hash = this.createHash(text + provider);
            this.textCache.delete(hash);
        }
        this.saveCache();
    }
    // Clear cache for specific provider
    clearProviderCache(provider) {
        // Clear text cache for provider
        for (const [key, entry] of this.textCache.entries()) {
            if (entry.provider === provider) {
                this.textCache.delete(key);
            }
        }
        // Clear file cache for provider
        for (const [key, entry] of this.fileCache.entries()) {
            if (entry.provider === provider) {
                this.fileCache.delete(key);
            }
        }
        this.saveCache();
    }
    // Clear all cache
    clearAll() {
        this.textCache.clear();
        this.fileCache.clear();
        this.saveCache();
    }
    // Clean old cache entries (older than 30 days)
    cleanOldEntries() {
        const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
        for (const [key, entry] of this.textCache.entries()) {
            if (entry.timestamp < thirtyDaysAgo) {
                this.textCache.delete(key);
            }
        }
        for (const [key, entry] of this.fileCache.entries()) {
            if (entry.timestamp < thirtyDaysAgo) {
                this.fileCache.delete(key);
            }
        }
        this.saveCache();
    }
    loadCache() {
        try {
            const textCacheData = this.context.globalState.get('translationTextCache', []);
            const fileCacheData = this.context.globalState.get('translationFileCache', []);
            this.textCache = new Map(textCacheData);
            this.fileCache = new Map(fileCacheData);
            // Clean old entries on load
            this.cleanOldEntries();
        }
        catch (error) {
            console.warn('Failed to load translation cache:', error);
            this.textCache.clear();
            this.fileCache.clear();
        }
    }
    saveCache() {
        try {
            this.context.globalState.update('translationTextCache', Array.from(this.textCache.entries()));
            this.context.globalState.update('translationFileCache', Array.from(this.fileCache.entries()));
        }
        catch (error) {
            console.warn('Failed to save translation cache:', error);
        }
    }
    // Get cache statistics
    getStats() {
        const providers = new Set();
        for (const entry of this.textCache.values()) {
            providers.add(entry.provider);
        }
        for (const entry of this.fileCache.values()) {
            providers.add(entry.provider);
        }
        return {
            textEntries: this.textCache.size,
            fileEntries: this.fileCache.size,
            providers: Array.from(providers)
        };
    }
}
exports.TranslationCache = TranslationCache;


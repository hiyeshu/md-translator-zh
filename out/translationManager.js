"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TranslationManager = void 0;
const logger_1 = require("./logger");
const vscode = require("vscode");
const translationProviders_1 = require("./translationProviders");
const translationCache_1 = require("./translationCache");
class TranslationManager {
    constructor(context) {
        this.providers = new Map();
        this.providers.set('google', new translationProviders_1.GoogleTranslateProvider());
        this.providers.set('azure', new translationProviders_1.AzureTranslateProvider());
        this.providers.set('custom', new translationProviders_1.CustomTranslateProvider());
        this.cache = new translationCache_1.TranslationCache(context);
    }
    getCurrentProvider() {
        const config = vscode.workspace.getConfiguration('mdcarrot');
        return config.get('provider') || 'google';
    }
    getCurrentCacheNamespace() {
        return `${this.getCurrentProvider()}:zh-CN`;
    }
    getCurrentProviderInstance() {
        return this.getProvider();
    }
    getProvider() {
        const providerName = this.getCurrentProvider();
        const provider = this.providers.get(providerName);
        if (!provider) {
            throw new Error(`Translation provider '${providerName}' not found`);
        }
        return provider;
    }
    // Delta translation with progress callback
    async translateDeltasWithProgress(deltas, onProgress) {
        if (deltas.length === 0) {
            return [];
        }
        const provider = this.getProvider();
        const cacheNamespace = this.getCurrentCacheNamespace();
        // Extract only the new text that needs translation
        const textsToTranslate = deltas
            .filter(delta => delta.newText.trim().length > 0)
            .map(delta => delta.newText);
        if (textsToTranslate.length === 0) {
            return [];
        }
        logger_1.Logger.debug(`Delta translation: ${textsToTranslate.length} fragments, ${textsToTranslate.join('').length} chars`);
        // Check cache for each fragment
        const cachedResults = new Map();
        const uncachedTexts = [];
        for (const text of textsToTranslate) {
            const cached = this.cache.getCached(text, cacheNamespace);
            if (cached) {
                cachedResults.set(text, cached);
            }
            else {
                uncachedTexts.push(text);
            }
        }
        // Report initial progress (cached items)
        const totalItems = textsToTranslate.length;
        let completedItems = cachedResults.size;
        onProgress?.(completedItems, totalItems);
        // Translate uncached fragments with parallel processing and progress
        const newTranslations = new Map();
        if (uncachedTexts.length > 0) {
            logger_1.Logger.debug(`Translating ${uncachedTexts.length} new fragments in parallel`);
            // Batch processing for better performance
            const batchSize = Math.min(5, uncachedTexts.length);
            const batches = [];
            for (let i = 0; i < uncachedTexts.length; i += batchSize) {
                batches.push(uncachedTexts.slice(i, i + batchSize));
            }
            // Process batches with progress updates
            for (const batch of batches) {
                const batchPromises = batch.map(async (text) => {
                    let retries = 0;
                    const maxRetries = 2;
                    while (retries <= maxRetries) {
                        try {
                            const translation = await provider.translate(text);
                            if (translation && translation.trim()) {
                                return { text, translation, success: true };
                            }
                            else {
                                throw new Error('Empty translation received');
                            }
                        }
                        catch (error) {
                            retries++;
                            if (retries > maxRetries) {
                                console.warn(`Translation failed for: ${text.substring(0, 50)}...`);
                                return { text, translation: text, success: false };
                            }
                            await new Promise(resolve => setTimeout(resolve, 500 * retries));
                        }
                    }
                    return { text, translation: text, success: false };
                });
                const batchResults = await Promise.all(batchPromises);
                // Store results and update progress
                for (const result of batchResults) {
                    newTranslations.set(result.text, result.translation);
                    if (result.success) {
                        this.cache.cache(result.text, result.translation, cacheNamespace);
                    }
                    completedItems++;
                    onProgress?.(completedItems, totalItems);
                }
                // Small delay between batches
                if (batches.indexOf(batch) < batches.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }
        }
        // Combine cached and new translations in original order
        const results = textsToTranslate.map(text => cachedResults.get(text) || newTranslations.get(text) || text);
        if (results.length !== textsToTranslate.length) {
            throw new Error(`Translation count mismatch: expected ${textsToTranslate.length}, got ${results.length}`);
        }
        return results;
    }
    // Delta-based translation - only translate changed fragments
    async translateDeltas(deltas) {
        if (deltas.length === 0) {
            return [];
        }
        const provider = this.getProvider();
        const cacheNamespace = this.getCurrentCacheNamespace();
        // Extract only the new text that needs translation
        const textsToTranslate = deltas
            .filter(delta => delta.newText.trim().length > 0)
            .map(delta => delta.newText);
        if (textsToTranslate.length === 0) {
            return [];
        }
        logger_1.Logger.debug(`Delta translation: ${textsToTranslate.length} fragments, ${textsToTranslate.join('').length} chars`);
        // Check cache for each fragment
        const cachedResults = new Map();
        const uncachedTexts = [];
        for (const text of textsToTranslate) {
            const cached = this.cache.getCached(text, cacheNamespace);
            if (cached) {
                cachedResults.set(text, cached);
            }
            else {
                uncachedTexts.push(text);
            }
        }
        // Translate uncached fragments with parallel processing
        const newTranslations = new Map();
        if (uncachedTexts.length > 0) {
            logger_1.Logger.debug(`Translating ${uncachedTexts.length} new fragments in parallel`);
            // Batch processing for better performance
            const batchSize = Math.min(5, uncachedTexts.length); // Max 5 concurrent requests
            const batches = [];
            for (let i = 0; i < uncachedTexts.length; i += batchSize) {
                batches.push(uncachedTexts.slice(i, i + batchSize));
            }
            // Process batches sequentially, but items within batch in parallel
            for (const batch of batches) {
                const batchPromises = batch.map(async (text) => {
                    let retries = 0;
                    const maxRetries = 2;
                    while (retries <= maxRetries) {
                        try {
                            const translation = await provider.translate(text);
                            if (translation && translation.trim()) {
                                return { text, translation, success: true };
                            }
                            else {
                                throw new Error('Empty translation received');
                            }
                        }
                        catch (error) {
                            retries++;
                            if (retries > maxRetries) {
                                console.warn(`Translation failed for: ${text.substring(0, 50)}...`);
                                return { text, translation: text, success: false }; // Fallback
                            }
                            // Exponential backoff
                            await new Promise(resolve => setTimeout(resolve, 500 * retries));
                        }
                    }
                    return { text, translation: text, success: false };
                });
                // Wait for current batch to complete
                const batchResults = await Promise.all(batchPromises);
                // Store results and cache successful translations
                for (const result of batchResults) {
                    newTranslations.set(result.text, result.translation);
                    if (result.success) {
                        this.cache.cache(result.text, result.translation, cacheNamespace);
                    }
                }
                // Small delay between batches to avoid rate limiting
                if (batches.indexOf(batch) < batches.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }
        }
        // Combine cached and new translations in original order
        const results = textsToTranslate.map(text => cachedResults.get(text) || newTranslations.get(text) || text);
        // Validate results
        if (results.length !== textsToTranslate.length) {
            throw new Error(`Translation count mismatch: expected ${textsToTranslate.length}, got ${results.length}`);
        }
        return results;
    }
    // Smart incremental translation - only translate changed parts
    async translateIncremental(oldContent, newContent, oldTranslations) {
        if (!oldContent || !newContent) {
            return this.translateBatch([newContent]);
        }
        const provider = this.getProvider();
        // Detect changes at paragraph/sentence level
        const oldLines = oldContent.split('\n');
        const newLines = newContent.split('\n');
        const changedLines = [];
        const lineMapping = new Map();
        // Find changed lines
        for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
            const oldLine = oldLines[i] || '';
            const newLine = newLines[i] || '';
            if (oldLine !== newLine) {
                changedLines.push(newLine);
                lineMapping.set(changedLines.length - 1, i);
            }
        }
        if (changedLines.length === 0) {
            // No changes - return cached translations
            return oldTranslations.map(t => t.value || t);
        }
        logger_1.Logger.debug(`Incremental translation: ${changedLines.length}/${newLines.length} lines changed`);
        // Translate only changed lines
        const newTranslations = await this.translateBatch(changedLines);
        // Merge with existing translations
        const result = [];
        let changedIndex = 0;
        for (let i = 0; i < newLines.length; i++) {
            if (lineMapping.has(changedIndex) && lineMapping.get(changedIndex) === i) {
                result.push(newTranslations[changedIndex]);
                changedIndex++;
            }
            else if (i < oldTranslations.length) {
                result.push(oldTranslations[i].value || oldTranslations[i]);
            }
            else {
                result.push(newLines[i]); // Fallback for new lines
            }
        }
        return result;
    }
    // Optimized batch translation with caching
    async translateBatch(texts) {
        if (texts.length === 0)
            return [];
        const provider = this.getProvider();
        const cacheNamespace = this.getCurrentCacheNamespace();
        // Remove duplicates and get unique texts
        const uniqueTexts = [...new Set(texts)];
        // Check cache for existing translations
        const cachedResults = this.cache.getBatchCached(uniqueTexts, cacheNamespace);
        const uncachedTexts = this.cache.getUncachedTexts(uniqueTexts, cacheNamespace);
        logger_1.Logger.debug(`Cache hit: ${cachedResults.size}/${uniqueTexts.length} texts, translating ${uncachedTexts.length} new texts`);
        // Translate only uncached texts
        const newTranslations = new Map();
        if (uncachedTexts.length > 0) {
            try {
                // Parallel processing with controlled concurrency
                const concurrency = Math.min(3, uncachedTexts.length); // Max 3 concurrent requests
                const batches = [];
                for (let i = 0; i < uncachedTexts.length; i += concurrency) {
                    batches.push(uncachedTexts.slice(i, i + concurrency));
                }
                for (const batch of batches) {
                    const batchPromises = batch.map(async (text) => {
                        try {
                            const translated = await provider.translate(text);
                            return { text, translated, success: true };
                        }
                        catch (error) {
                            console.warn(`Failed to translate: "${text.substring(0, 30)}..."`, error);
                            return { text, translated: text, success: false }; // Fallback
                        }
                    });
                    const results = await Promise.all(batchPromises);
                    for (const result of results) {
                        newTranslations.set(result.text, result.translated);
                        if (result.success) {
                            this.cache.cache(result.text, result.translated, cacheNamespace);
                        }
                    }
                    // Brief pause between batches
                    if (batches.indexOf(batch) < batches.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 50));
                    }
                }
            }
            catch (error) {
                console.error('Batch translation failed:', error);
                // Fallback: return original texts for failed translations
                for (const text of uncachedTexts) {
                    if (!newTranslations.has(text)) {
                        newTranslations.set(text, text);
                    }
                }
            }
        }
        // Combine cached and new translations
        const allTranslations = new Map([...cachedResults, ...newTranslations]);
        // Return results in original order, handling duplicates
        return texts.map(text => allTranslations.get(text) || text);
    }
    // Single text translation with caching
    async translate(text) {
        const results = await this.translateBatch([text]);
        return results[0] || text;
    }
    // Check if file translation is cached
    isFileCached(filePath, content) {
        return this.cache.isFileCached(filePath, content, this.getCurrentCacheNamespace());
    }
    // Get cached file translation
    getCachedFileTranslation(filePath) {
        return this.cache.getCachedFileTranslation(filePath);
    }
    // Cache file translation
    cacheFileTranslation(filePath, content, translatedNodes) {
        this.cache.cacheFileTranslation(filePath, content, this.getCurrentCacheNamespace(), translatedNodes);
    }
    // Clear cache for specific file
    clearFileCache(filePath) {
        this.cache.clearFileCache(filePath);
    }
    // Clear cache for specific texts
    async clearTextCache(texts) {
        this.cache.clearTextCache(texts, this.getCurrentCacheNamespace());
    }
    // Clear cache for current provider
    clearProviderCache() {
        const providerName = this.getCurrentProvider();
        this.cache.clearProviderCache(this.getCurrentCacheNamespace());
        vscode.window.showInformationMessage(`已清除 ${providerName} 的简体中文缓存`);
    }
    // Clear all cache
    clearAllCache() {
        this.cache.clearAll();
        vscode.window.showInformationMessage('All translation cache cleared');
    }
    // Get cache statistics
    getCacheStats() {
        return this.cache.getStats();
    }
}
exports.TranslationManager = TranslationManager;
//# sourceMappingURL=translationManager.js.map

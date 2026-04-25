import * as vscode from 'vscode';
import { Logger } from './logger';
import { FreeTranslateProvider, GoogleTranslateProvider, VolcengineTranslateProvider } from './translationProviders';
import { TranslationCache } from './translationCache';
import { getConfigValue } from './config';
import { TextNode } from './markdownProcessor';

import { QuotaInfo } from './translationProviders';

export interface TranslateProvider {
    translate(text: string): Promise<string>;
    translateBatch?(texts: string[]): Promise<string[]>;
    getQuota?(): Promise<QuotaInfo>;
}

interface Delta {
    newText: string;
}

interface TranslationResult {
    text: string;
    translation: string;
    success: boolean;
}

export class TranslationManager {
    private providers = new Map<string, TranslateProvider>();
    private cache: TranslationCache;

    constructor(context: vscode.ExtensionContext) {
        this.providers.set('free', new FreeTranslateProvider());
        this.providers.set('volcengine', new VolcengineTranslateProvider());
        this.providers.set('google', new GoogleTranslateProvider());
        this.cache = new TranslationCache(context);
    }

    getCurrentProvider(): string {
        return getConfigValue('provider', 'free') || 'free';
    }

    private getCurrentCacheNamespace(): string {
        return `${this.getCurrentProvider()}:zh-CN`;
    }

    getCurrentProviderInstance(): TranslateProvider {
        return this.getProvider();
    }

    private getProvider(): TranslateProvider {
        const providerName = this.getCurrentProvider();
        const provider = this.providers.get(providerName);
        if (!provider) throw new Error(`Translation provider '${providerName}' not found`);
        return provider;
    }
    async translateDeltasWithProgress(deltas: Delta[], onProgress?: (completed: number, total: number) => void): Promise<string[]> {
        if (deltas.length === 0) return [];
        const provider = this.getProvider();
        const cacheNamespace = this.getCurrentCacheNamespace();
        const textsToTranslate = deltas.filter(d => d.newText.trim().length > 0).map(d => d.newText);
        if (textsToTranslate.length === 0) return [];
        Logger.debug(`Delta translation: ${textsToTranslate.length} fragments, ${textsToTranslate.join('').length} chars`);
        const cachedResults = new Map<string, string>();
        const uncachedTexts: string[] = [];
        for (const text of textsToTranslate) {
            const cached = this.cache.getCached(text, cacheNamespace);
            if (cached) { cachedResults.set(text, cached); } else { uncachedTexts.push(text); }
        }
        const totalItems = textsToTranslate.length;
        let completedItems = cachedResults.size;
        onProgress?.(completedItems, totalItems);
        const newTranslations = new Map<string, string>();
        if (uncachedTexts.length > 0) {
            Logger.debug(`Translating ${uncachedTexts.length} new fragments`);
            const batchSize = provider.translateBatch ? uncachedTexts.length : Math.min(5, uncachedTexts.length);
            const batches: string[][] = [];
            for (let i = 0; i < uncachedTexts.length; i += batchSize) batches.push(uncachedTexts.slice(i, i + batchSize));
            for (const batch of batches) {
                const batchResults = await this._translateMany(provider, batch);
                for (const result of batchResults) {
                    newTranslations.set(result.text, result.translation);
                    if (result.success) this.cache.cache(result.text, result.translation, cacheNamespace);
                    completedItems++;
                    onProgress?.(completedItems, totalItems);
                }
                if (batches.indexOf(batch) < batches.length - 1) await new Promise(r => setTimeout(r, 100));
            }
        }
        const results = textsToTranslate.map(text => cachedResults.get(text) || newTranslations.get(text) || text);
        if (results.length !== textsToTranslate.length) throw new Error(`Translation count mismatch: expected ${textsToTranslate.length}, got ${results.length}`);
        return results;
    }

    private async _translateWithRetry(provider: TranslateProvider, text: string, maxRetries = 2): Promise<TranslationResult> {
        let retries = 0;
        while (retries <= maxRetries) {
            try {
                const translation = await provider.translate(text);
                if (translation && translation.trim()) return { text, translation, success: true };
                throw new Error('Empty translation received');
            } catch {
                retries++;
                if (retries > maxRetries) return { text, translation: text, success: false };
                await new Promise(r => setTimeout(r, 500 * retries));
            }
        }
        return { text, translation: text, success: false };
    }

    private async _translateMany(provider: TranslateProvider, texts: string[]): Promise<TranslationResult[]> {
        if (texts.length === 0) return [];
        if (!provider.translateBatch) {
            return Promise.all(texts.map(text => this._translateWithRetry(provider, text)));
        }
        try {
            const translations = await provider.translateBatch(texts);
            if (translations.length !== texts.length) {
                throw new Error(`Batch translation count mismatch: expected ${texts.length}, got ${translations.length}`);
            }
            return texts.map((text, index) => {
                const translation = translations[index];
                return {
                    text,
                    translation: translation && translation.trim() ? translation : text,
                    success: Boolean(translation && translation.trim())
                };
            });
        } catch {
            return Promise.all(texts.map(text => this._translateWithRetry(provider, text)));
        }
    }
    async translateDeltas(deltas: Delta[]): Promise<string[]> {
        if (deltas.length === 0) return [];
        const provider = this.getProvider();
        const cacheNamespace = this.getCurrentCacheNamespace();
        const textsToTranslate = deltas.filter(d => d.newText.trim().length > 0).map(d => d.newText);
        if (textsToTranslate.length === 0) return [];
        Logger.debug(`Delta translation: ${textsToTranslate.length} fragments, ${textsToTranslate.join('').length} chars`);
        const cachedResults = new Map<string, string>();
        const uncachedTexts: string[] = [];
        for (const text of textsToTranslate) {
            const cached = this.cache.getCached(text, cacheNamespace);
            if (cached) { cachedResults.set(text, cached); } else { uncachedTexts.push(text); }
        }
        const newTranslations = new Map<string, string>();
        if (uncachedTexts.length > 0) {
            Logger.debug(`Translating ${uncachedTexts.length} new fragments`);
            const batchSize = provider.translateBatch ? uncachedTexts.length : Math.min(5, uncachedTexts.length);
            const batches: string[][] = [];
            for (let i = 0; i < uncachedTexts.length; i += batchSize) batches.push(uncachedTexts.slice(i, i + batchSize));
            for (const batch of batches) {
                const batchResults = await this._translateMany(provider, batch);
                for (const result of batchResults) {
                    newTranslations.set(result.text, result.translation);
                    if (result.success) this.cache.cache(result.text, result.translation, cacheNamespace);
                }
                if (batches.indexOf(batch) < batches.length - 1) await new Promise(r => setTimeout(r, 100));
            }
        }
        const results = textsToTranslate.map(text => cachedResults.get(text) || newTranslations.get(text) || text);
        if (results.length !== textsToTranslate.length) throw new Error(`Translation count mismatch: expected ${textsToTranslate.length}, got ${results.length}`);
        return results;
    }

    async translateIncremental(oldContent: string, newContent: string, oldTranslations: (TextNode | string)[]): Promise<string[]> {
        if (!oldContent || !newContent) return this.translateBatch([newContent]);
        const oldLines = oldContent.split('\n');
        const newLines = newContent.split('\n');
        const changedLines: string[] = [];
        const lineMapping = new Map<number, number>();
        for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
            if ((oldLines[i] || '') !== (newLines[i] || '')) {
                changedLines.push(newLines[i] || '');
                lineMapping.set(changedLines.length - 1, i);
            }
        }
        if (changedLines.length === 0) {
            return oldTranslations.map(t => typeof t === 'string' ? t : t.value || '');
        }
        Logger.debug(`Incremental translation: ${changedLines.length}/${newLines.length} lines changed`);
        const newTranslations = await this.translateBatch(changedLines);
        const result: string[] = [];
        let changedIndex = 0;
        for (let i = 0; i < newLines.length; i++) {
            if (lineMapping.has(changedIndex) && lineMapping.get(changedIndex) === i) {
                result.push(newTranslations[changedIndex]);
                changedIndex++;
            } else if (i < oldTranslations.length) {
                const t = oldTranslations[i];
                result.push(typeof t === 'string' ? t : t.value || '');
            } else { result.push(newLines[i]); }
        }
        return result;
    }
    async translateBatch(texts: string[]): Promise<string[]> {
        if (texts.length === 0) return [];
        const provider = this.getProvider();
        const cacheNamespace = this.getCurrentCacheNamespace();
        const uniqueTexts = [...new Set(texts)];
        const cachedResults = this.cache.getBatchCached(uniqueTexts, cacheNamespace);
        const uncachedTexts = this.cache.getUncachedTexts(uniqueTexts, cacheNamespace);
        Logger.debug(`Cache hit: ${cachedResults.size}/${uniqueTexts.length} texts, translating ${uncachedTexts.length} new texts`);
        const newTranslations = new Map<string, string>();
        if (uncachedTexts.length > 0) {
            try {
                const concurrency = provider.translateBatch ? uncachedTexts.length : Math.min(3, uncachedTexts.length);
                const batches: string[][] = [];
                for (let i = 0; i < uncachedTexts.length; i += concurrency) batches.push(uncachedTexts.slice(i, i + concurrency));
                for (const batch of batches) {
                    const results = await this._translateMany(provider, batch);
                    for (const result of results) {
                        newTranslations.set(result.text, result.translation);
                        if (result.success) this.cache.cache(result.text, result.translation, cacheNamespace);
                    }
                    if (batches.indexOf(batch) < batches.length - 1) await new Promise(r => setTimeout(r, 50));
                }
            } catch {
                for (const text of uncachedTexts) { if (!newTranslations.has(text)) newTranslations.set(text, text); }
            }
        }
        const allTranslations = new Map([...cachedResults, ...newTranslations]);
        return texts.map(text => allTranslations.get(text) || text);
    }

    async translate(text: string): Promise<string> {
        const results = await this.translateBatch([text]);
        return results[0] || text;
    }

    isFileCached(filePath: string, content: string): boolean {
        return this.cache.isFileCached(filePath, content, this.getCurrentCacheNamespace());
    }

    getCachedFileTranslation(filePath: string): TextNode[] | null {
        return this.cache.getCachedFileTranslation(filePath);
    }

    cacheFileTranslation(filePath: string, content: string, translatedNodes: TextNode[]): void {
        this.cache.cacheFileTranslation(filePath, content, this.getCurrentCacheNamespace(), translatedNodes);
    }

    clearFileCache(filePath: string): void { this.cache.clearFileCache(filePath); }

    clearTextCache(texts: string[]): void { this.cache.clearTextCache(texts, this.getCurrentCacheNamespace()); }

    clearProviderCache(): void {
        const providerName = this.getCurrentProvider();
        this.cache.clearProviderCache(this.getCurrentCacheNamespace());
        vscode.window.showInformationMessage(`已清除 ${providerName} 的简体中文缓存`);
    }

    clearAllCache(): void {
        this.cache.clearAll();
        vscode.window.showInformationMessage('All translation cache cleared');
    }

    getCacheStats(): { textEntries: number; fileEntries: number; providers: string[] } {
        return this.cache.getStats();
    }
}

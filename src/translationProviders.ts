// @ts-nocheck
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomTranslateProvider = exports.AzureTranslateProvider = exports.GoogleTranslateProvider = exports.FreeTranslateProvider = void 0;
const https = require("https");
const config_1 = require("./config");
const DEFAULT_TARGET_LANGUAGE = 'zh-CN';
const AZURE_TARGET_LANGUAGE = 'zh-Hans';
const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 10,
    maxFreeSockets: 5,
    timeout: 30000
});
function httpsRequest(url, options) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const reqOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || 443,
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: {
                'Connection': 'keep-alive',
                ...options.headers
            },
            agent: httpsAgent
        };
        const req = https.request(reqOptions, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                const response = {
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    json: () => Promise.resolve(data ? JSON.parse(data) : {}),
                    text: () => Promise.resolve(data)
                };
                resolve(response);
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}
function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function normalizeGoogleWebLanguage(value, fallback = 'auto') {
    const normalized = normalizeString(value);
    if (!normalized) {
        return fallback;
    }
    const lower = normalized.toLowerCase();
    if (lower === 'zh-cn' || lower === 'zh_cn') {
        return 'zh-CN';
    }
    if (lower === 'zh-tw' || lower === 'zh_tw') {
        return 'zh-TW';
    }
    return normalized.split('-')[0];
}
function decodeHtmlEntities(text) {
    return text
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}
function getFreeGoogleMirror() {
    return normalizeString((0, config_1.getConfigValue)('free.googleMirror', ''));
}
function getCustomEndpoint() {
    return normalizeString((0, config_1.getConfigValue)('custom.endpoint', ''));
}
function getCustomToken() {
    return normalizeString((0, config_1.getConfigValue)('custom.token', ''));
}
function parseCustomTranslation(result) {
    if (typeof result?.text === 'string' && result.text.trim()) {
        return result.text;
    }
    const translations = Array.isArray(result?.translations) ? result.translations : [];
    if (translations.length === 0) {
        return '';
    }
    const first = translations[0];
    if (typeof first === 'string') {
        return first;
    }
    if (typeof first?.text === 'string') {
        return first.text;
    }
    return '';
}
class FreeTranslateProvider {
    async translate(text) {
        const services = [
            () => this.translateWithGoogleWeb(text),
            () => this.translateWithMyMemory(text)
        ];
        let lastError = null;
        for (const service of services) {
            try {
                const translated = await service();
                if (translated && translated.trim() && translated.trim() !== text.trim()) {
                    return translated;
                }
            }
            catch (error) {
                lastError = error instanceof Error ? error : new Error('Unknown error');
            }
        }
        throw new Error(`免费翻译暂时不可用：${lastError?.message || '所有免费服务都失败了'}`);
    }
    async translateWithGoogleWeb(text) {
        const mirror = getFreeGoogleMirror();
        const query = new URLSearchParams();
        query.append('client', 'gtx');
        query.append('sl', 'auto');
        query.append('tl', normalizeGoogleWebLanguage(DEFAULT_TARGET_LANGUAGE, 'zh-CN'));
        query.append('hl', normalizeGoogleWebLanguage(DEFAULT_TARGET_LANGUAGE, 'zh-CN'));
        query.append('ie', 'UTF-8');
        query.append('oe', 'UTF-8');
        query.append('otf', '1');
        query.append('ssel', '0');
        query.append('tsel', '0');
        query.append('kc', '7');
        query.append('q', text);
        ['at', 'bd', 'ex', 'ld', 'md', 'qca', 'rw', 'rm', 'ss', 't'].forEach(item => {
            query.append('dt', item);
        });
        const baseUrl = mirror || 'https://translate.googleapis.com';
        const response = await httpsRequest(`${baseUrl}/translate_a/single?${query.toString()}`, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept': '*/*'
            }
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Google 网页端点失败：HTTP ${response.status}: ${errorText}`);
        }
        const result = await response.json();
        const translated = Array.isArray(result?.[0])
            ? result[0].map(item => typeof item?.[0] === 'string' ? item[0] : '').join('')
            : '';
        if (!translated.trim()) {
            throw new Error('Google 网页端点返回为空');
        }
        return decodeHtmlEntities(translated);
    }
    async translateWithMyMemory(text) {
        const query = new URLSearchParams();
        query.append('q', text);
        query.append('langpair', `en|${normalizeGoogleWebLanguage(DEFAULT_TARGET_LANGUAGE, 'zh-CN')}`);
        const response = await httpsRequest(`https://api.mymemory.translated.net/get?${query.toString()}`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json'
            }
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`MyMemory 失败：HTTP ${response.status}: ${errorText}`);
        }
        const result = await response.json();
        const translated = normalizeString(result?.responseData?.translatedText);
        if (!translated || translated === text || translated === text.toUpperCase()) {
            throw new Error('MyMemory 返回为空');
        }
        return decodeHtmlEntities(translated);
    }
    async getQuota() {
        try {
            await this.translate('hello');
            return {
                currency: 'USD',
                resetDate: '实验性免费接口，无固定额度，可能被限流',
                error: ''
            };
        }
        catch (error) {
            return { error: '免费翻译服务暂时不可用' };
        }
    }
}
exports.FreeTranslateProvider = FreeTranslateProvider;
class GoogleTranslateProvider {
    async translate(text) {
        const apiKey = normalizeString((0, config_1.getConfigValue)('google.apiKey', ''));
        if (!apiKey) {
            throw new Error('Google Translate API Key 还没配置');
        }
        let lastError = null;
        for (let attempt = 1; attempt <= GoogleTranslateProvider.MAX_RETRIES; attempt++) {
            try {
                const response = await httpsRequest(`https://translation.googleapis.com/language/translate/v2?key=${apiKey}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        q: text,
                        target: DEFAULT_TARGET_LANGUAGE,
                        format: 'text'
                    })
                });
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`HTTP ${response.status}: ${errorText}`);
                }
                const result = await response.json();
                const translatedText = result.data?.translations?.[0]?.translatedText;
                if (!translatedText) {
                    throw new Error('Google 返回的数据不对');
                }
                return translatedText;
            }
            catch (error) {
                lastError = error instanceof Error ? error : new Error('Unknown error');
                if (attempt < GoogleTranslateProvider.MAX_RETRIES) {
                    await new Promise(resolve => setTimeout(resolve, GoogleTranslateProvider.RETRY_DELAY * attempt));
                    continue;
                }
            }
        }
        throw new Error(`Google Translate 请求失败：${lastError?.message}`);
    }
    async getQuota() {
        const apiKey = normalizeString((0, config_1.getConfigValue)('google.apiKey', ''));
        if (!apiKey) {
            return { error: 'API Key 还没配置' };
        }
        try {
            const response = await httpsRequest(`https://translation.googleapis.com/language/translate/v2/languages?key=${apiKey}&target=en`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' }
            });
            if (response.ok) {
                return {
                    currency: 'USD',
                    resetDate: '请去 Google Cloud Console 看实际用量',
                    error: 'Google 不会在这里直接返回剩余额度'
                };
            }
            return { error: 'API Key 无效，或者额度已经超了' };
        }
        catch (error) {
            return { error: '拿不到额度信息' };
        }
    }
}
exports.GoogleTranslateProvider = GoogleTranslateProvider;
GoogleTranslateProvider.MAX_RETRIES = 3;
GoogleTranslateProvider.RETRY_DELAY = 1000;
class AzureTranslateProvider {
    async translate(text) {
        const key = normalizeString((0, config_1.getConfigValue)('azure.key', ''));
        const region = normalizeString((0, config_1.getConfigValue)('azure.region', 'eastus')) || 'eastus';
        if (!key) {
            throw new Error('Azure Translator Key 还没配置');
        }
        let lastError = null;
        for (let attempt = 1; attempt <= AzureTranslateProvider.MAX_RETRIES; attempt++) {
            try {
                const response = await httpsRequest(`https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${AZURE_TARGET_LANGUAGE}`, {
                    method: 'POST',
                    headers: {
                        'Ocp-Apim-Subscription-Key': key,
                        'Ocp-Apim-Subscription-Region': region,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify([{ text }])
                });
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`HTTP ${response.status}: ${errorText}`);
                }
                const result = await response.json();
                const translatedText = result?.[0]?.translations?.[0]?.text;
                if (!translatedText) {
                    throw new Error('Azure 返回的数据不对');
                }
                return translatedText;
            }
            catch (error) {
                lastError = error instanceof Error ? error : new Error('Unknown error');
                if (attempt < AzureTranslateProvider.MAX_RETRIES) {
                    await new Promise(resolve => setTimeout(resolve, AzureTranslateProvider.RETRY_DELAY * attempt));
                    continue;
                }
            }
        }
        throw new Error(`Azure Translate 请求失败：${lastError?.message}`);
    }
    async getQuota() {
        const key = normalizeString((0, config_1.getConfigValue)('azure.key', ''));
        const region = normalizeString((0, config_1.getConfigValue)('azure.region', 'eastus')) || 'eastus';
        if (!key) {
            return { error: 'API Key 还没配置' };
        }
        try {
            const response = await httpsRequest(`https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${AZURE_TARGET_LANGUAGE}`, {
                method: 'POST',
                headers: {
                    'Ocp-Apim-Subscription-Key': key,
                    'Ocp-Apim-Subscription-Region': region,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify([{ text: 'test' }])
            });
            if (response.ok) {
                return {
                    currency: 'USD',
                    resetDate: '请去 Azure Portal 看实际用量',
                    error: 'Azure 不会在这里直接返回剩余额度'
                };
            }
            if (response.status === 403) {
                return { error: '额度超了，或者 Key 不对' };
            }
            return { error: `API error: ${response.status}` };
        }
        catch (error) {
            return { error: '拿不到额度信息' };
        }
    }
}
exports.AzureTranslateProvider = AzureTranslateProvider;
AzureTranslateProvider.MAX_RETRIES = 3;
AzureTranslateProvider.RETRY_DELAY = 1000;
class CustomTranslateProvider {
    async translate(text) {
        const endpoint = getCustomEndpoint();
        const token = getCustomToken();
        if (!endpoint) {
            throw new Error('自定义 API 地址还没配置');
        }
        const headers = {
            'Content-Type': 'application/json'
        };
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
        const response = await httpsRequest(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                texts: [text],
                sourceLang: 'auto',
                targetLang: DEFAULT_TARGET_LANGUAGE,
                format: 'text',
                provider: 'custom'
            })
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`自定义 API 请求失败：HTTP ${response.status}: ${errorText}`);
        }
        const result = await response.json();
        const translatedText = parseCustomTranslation(result);
        if (!translatedText) {
            throw new Error('自定义 API 返回的数据不对');
        }
        return translatedText;
    }
    async getQuota() {
        return { error: '自定义 API 没有统一额度接口' };
    }
}
exports.CustomTranslateProvider = CustomTranslateProvider;

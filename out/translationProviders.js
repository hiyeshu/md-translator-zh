"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomTranslateProvider = exports.AzureTranslateProvider = exports.GoogleTranslateProvider = void 0;
const vscode = require("vscode");
const https = require("https");
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
function getConfig() {
    return vscode.workspace.getConfiguration('mdcarrot');
}
function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function getCustomEndpoint() {
    return normalizeString(getConfig().get('custom.endpoint'));
}
function getCustomToken() {
    return normalizeString(getConfig().get('custom.token'));
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
class GoogleTranslateProvider {
    async translate(text) {
        const apiKey = normalizeString(getConfig().get('google.apiKey'));
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
        const apiKey = normalizeString(getConfig().get('google.apiKey'));
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
        const config = getConfig();
        const key = normalizeString(config.get('azure.key'));
        const region = normalizeString(config.get('azure.region')) || 'eastus';
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
        const config = getConfig();
        const key = normalizeString(config.get('azure.key'));
        const region = normalizeString(config.get('azure.region')) || 'eastus';
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

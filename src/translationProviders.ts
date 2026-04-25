import * as https from 'https';
import * as crypto from 'crypto';
import { getConfigValue } from './config';

const DEFAULT_TARGET_LANGUAGE = 'zh-CN';

interface HttpResponse {
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
}

export interface QuotaInfo {
    currency?: string;
    resetDate?: string;
    error: string;
}

interface VolcengineResponseMetadataError {
    Code?: string;
    Message?: string;
}

interface VolcengineTranslateResponse {
    TranslationList?: { Translation?: string; DetectedSourceLanguage?: string }[];
    ResponseMetadata?: {
        RequestId?: string;
        Action?: string;
        Version?: string;
        Service?: string;
        Region?: string;
        Error?: VolcengineResponseMetadataError | null;
    };
}

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10, maxFreeSockets: 5, timeout: 30000 });
const VOLCENGINE_ENDPOINT = 'https://translate.volcengineapi.com/';
const VOLCENGINE_HOST = 'translate.volcengineapi.com';
const VOLCENGINE_QUERY = 'Action=TranslateText&Version=2020-06-01';
const VOLCENGINE_REGION = 'cn-north-1';
const VOLCENGINE_SERVICE = 'translate';
const VOLCENGINE_MAX_ITEMS = 16;
const VOLCENGINE_MAX_TOTAL_LENGTH = 5000;
const VOLCENGINE_MAX_RETRIES = 3;

function httpsRequest(url: string, options: { method?: string; headers?: Record<string, string>; body?: string }): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const reqOptions: https.RequestOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || 443,
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: { 'Connection': 'keep-alive', ...options.headers },
            agent: httpsAgent
        };
        const req = https.request(reqOptions, (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => data += chunk);
            res.on('end', () => {
                resolve({
                    ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
                    status: res.statusCode ?? 0,
                    json: () => Promise.resolve(data ? JSON.parse(data) : {}),
                    text: () => Promise.resolve(data)
                });
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
        if (options.body) req.write(options.body);
        req.end();
    });
}
function normalizeString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeGoogleWebLanguage(value: string, fallback = 'auto'): string {
    const normalized = normalizeString(value);
    if (!normalized) return fallback;
    const lower = normalized.toLowerCase();
    if (lower === 'zh-cn' || lower === 'zh_cn') return 'zh-CN';
    if (lower === 'zh-tw' || lower === 'zh_tw') return 'zh-TW';
    return normalized.split('-')[0];
}

function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function getFreeGoogleMirror(): string {
    return normalizeString(getConfigValue('free.googleMirror', ''));
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class FreeTranslateProvider {
    async translate(text: string): Promise<string> {
        const services = [
            () => this.translateWithGoogleWeb(text),
            () => this.translateWithMyMemory(text)
        ];
        let lastError: Error | null = null;
        for (const service of services) {
            try {
                const translated = await service();
                if (translated && translated.trim() && translated.trim() !== text.trim()) return translated;
            } catch (error) {
                lastError = error instanceof Error ? error : new Error('Unknown error');
            }
        }
        throw new Error(`免费翻译暂时不可用：${lastError?.message || '所有免费服务都失败了'}`);
    }

    private async translateWithGoogleWeb(text: string): Promise<string> {
        const mirror = getFreeGoogleMirror();
        const query = new URLSearchParams();
        query.append('client', 'gtx');
        query.append('sl', 'auto');
        const tl = normalizeGoogleWebLanguage(DEFAULT_TARGET_LANGUAGE, 'zh-CN');
        query.append('tl', tl);
        query.append('hl', tl);
        query.append('ie', 'UTF-8'); query.append('oe', 'UTF-8');
        query.append('otf', '1'); query.append('ssel', '0'); query.append('tsel', '0'); query.append('kc', '7');
        query.append('q', text);
        ['at', 'bd', 'ex', 'ld', 'md', 'qca', 'rw', 'rm', 'ss', 't'].forEach(item => query.append('dt', item));
        const baseUrl = mirror || 'https://translate.googleapis.com';
        const response = await httpsRequest(`${baseUrl}/translate_a/single?${query.toString()}`, {
            method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' }
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Google 网页端点失败：HTTP ${response.status}: ${errorText}`);
        }
        const result = await response.json() as unknown[][];
        const translated = Array.isArray(result?.[0])
            ? (result[0] as unknown[][]).map(item => typeof item?.[0] === 'string' ? item[0] : '').join('')
            : '';
        if (!translated.trim()) throw new Error('Google 网页端点返回为空');
        return decodeHtmlEntities(translated);
    }

    private async translateWithMyMemory(text: string): Promise<string> {
        const query = new URLSearchParams();
        query.append('q', text);
        query.append('langpair', `en|${normalizeGoogleWebLanguage(DEFAULT_TARGET_LANGUAGE, 'zh-CN')}`);
        const response = await httpsRequest(`https://api.mymemory.translated.net/get?${query.toString()}`, {
            method: 'GET', headers: { 'Accept': 'application/json' }
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`MyMemory 失败：HTTP ${response.status}: ${errorText}`);
        }
        const result = await response.json() as { responseData?: { translatedText?: string } };
        const translated = normalizeString(result?.responseData?.translatedText);
        if (!translated || translated === text || translated === text.toUpperCase()) throw new Error('MyMemory 返回为空');
        return decodeHtmlEntities(translated);
    }

    async getQuota(): Promise<QuotaInfo> {
        try {
            await this.translate('hello');
            return { currency: 'USD', resetDate: '实验性免费接口，无固定额度，可能被限流', error: '' };
        } catch {
            return { error: '免费翻译服务暂时不可用' };
        }
    }
}
export class GoogleTranslateProvider {
    private static readonly MAX_RETRIES = 3;
    private static readonly RETRY_DELAY = 1000;

    async translate(text: string): Promise<string> {
        const apiKey = normalizeString(getConfigValue('google.apiKey', ''));
        if (!apiKey) throw new Error('Google Translate API Key 还没配置');
        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= GoogleTranslateProvider.MAX_RETRIES; attempt++) {
            try {
                const response = await httpsRequest(`https://translation.googleapis.com/language/translate/v2?key=${apiKey}`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ q: text, target: DEFAULT_TARGET_LANGUAGE, format: 'text' })
                });
                if (!response.ok) { const errorText = await response.text(); throw new Error(`HTTP ${response.status}: ${errorText}`); }
                const result = await response.json() as { data?: { translations?: { translatedText?: string }[] } };
                const translatedText = result.data?.translations?.[0]?.translatedText;
                if (!translatedText) throw new Error('Google 返回的数据不对');
                return translatedText;
            } catch (error) {
                lastError = error instanceof Error ? error : new Error('Unknown error');
                if (attempt < GoogleTranslateProvider.MAX_RETRIES) {
                    await new Promise(resolve => setTimeout(resolve, GoogleTranslateProvider.RETRY_DELAY * attempt));
                }
            }
        }
        throw new Error(`Google Translate 请求失败：${lastError?.message}`);
    }

    async getQuota(): Promise<QuotaInfo> {
        const apiKey = normalizeString(getConfigValue('google.apiKey', ''));
        if (!apiKey) return { error: 'API Key 还没配置' };
        try {
            const response = await httpsRequest(`https://translation.googleapis.com/language/translate/v2/languages?key=${apiKey}&target=en`, {
                method: 'GET', headers: { 'Content-Type': 'application/json' }
            });
            if (response.ok) return { currency: 'USD', resetDate: '请去 Google Cloud Console 看实际用量', error: 'Google 不会在这里直接返回剩余额度' };
            return { error: 'API Key 无效，或者额度已经超了' };
        } catch { return { error: '拿不到额度信息' }; }
    }
}
export class VolcengineTranslateProvider {
    async translate(text: string): Promise<string> {
        const [translated] = await this.translateBatch([text]);
        return translated || text;
    }

    async translateBatch(texts: string[]): Promise<string[]> {
        if (texts.length === 0) return [];
        const accessKeyId = normalizeString(getConfigValue('volcengine.accessKeyId', ''));
        const secretKey = normalizeString(getConfigValue('volcengine.secretKey', ''));
        const region = normalizeString(getConfigValue('volcengine.region', VOLCENGINE_REGION)) || VOLCENGINE_REGION;
        if (!accessKeyId || !secretKey) throw new Error('火山引擎 AccessKeyId / SecretKey 未配置');
        const chunks = this._chunkTexts(texts);
        const translations: string[] = [];
        for (const chunk of chunks) {
            const batchResult = await this._translateChunk(chunk, accessKeyId, secretKey, region);
            translations.push(...batchResult);
        }
        if (translations.length !== texts.length) {
            throw new Error(`火山引擎返回数量不对：期望 ${texts.length}，实际 ${translations.length}`);
        }
        return translations;
    }

    async getQuota(): Promise<QuotaInfo> {
        try {
            await this.translate('hello');
            return { currency: 'CNY', resetDate: '每月 200 万字符免费额度', error: '' };
        } catch (e) {
            return { error: e instanceof Error ? e.message : '连接失败' };
        }
    }

    private _chunkTexts(texts: string[]): string[][] {
        const chunks: string[][] = [];
        let currentChunk: string[] = [];
        let currentLength = 0;
        for (const text of texts) {
            const textLength = text.length;
            if (textLength > VOLCENGINE_MAX_TOTAL_LENGTH) {
                throw new Error(`火山引擎单段文本超过 ${VOLCENGINE_MAX_TOTAL_LENGTH} 字符限制`);
            }
            const exceedsChunkSize = currentChunk.length >= VOLCENGINE_MAX_ITEMS;
            const exceedsLengthLimit = currentLength + textLength > VOLCENGINE_MAX_TOTAL_LENGTH;
            if (currentChunk.length > 0 && (exceedsChunkSize || exceedsLengthLimit)) {
                chunks.push(currentChunk);
                currentChunk = [];
                currentLength = 0;
            }
            currentChunk.push(text);
            currentLength += textLength;
        }
        if (currentChunk.length > 0) chunks.push(currentChunk);
        return chunks;
    }

    private async _translateChunk(texts: string[], accessKeyId: string, secretKey: string, region: string): Promise<string[]> {
        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= VOLCENGINE_MAX_RETRIES; attempt++) {
            try {
                return await this._requestTranslations(texts, accessKeyId, secretKey, region);
            } catch (error) {
                lastError = error instanceof Error ? error : new Error('火山引擎请求失败');
                const shouldRetry = this._shouldRetry(lastError);
                if (!shouldRetry || attempt === VOLCENGINE_MAX_RETRIES) break;
                await sleep(400 * Math.pow(2, attempt - 1));
            }
        }
        throw lastError || new Error('火山引擎请求失败');
    }

    private async _requestTranslations(texts: string[], accessKeyId: string, secretKey: string, region: string): Promise<string[]> {
        const body = JSON.stringify({ TargetLanguage: 'zh', TextList: texts });
        const payloadHash = crypto.createHash('sha256').update(body).digest('hex');
        const headers = this._sign(accessKeyId, secretKey, region, VOLCENGINE_SERVICE, 'POST', '/', VOLCENGINE_QUERY, payloadHash);
        headers['Content-Type'] = 'application/json; charset=utf-8';
        const response = await httpsRequest(`${VOLCENGINE_ENDPOINT}?${VOLCENGINE_QUERY}`, { method: 'POST', headers, body });
        const raw = await response.text();
        const parsed = this._parseResponse(raw);
        const metadataError = parsed?.ResponseMetadata?.Error || null;
        if (metadataError?.Code) {
            throw this._buildApiError(metadataError, parsed?.ResponseMetadata?.RequestId);
        }
        if (!response.ok) {
            throw new Error(`火山引擎失败：HTTP ${response.status}${raw ? ` ${raw}` : ''}`);
        }
        const translationList = Array.isArray(parsed?.TranslationList) ? parsed.TranslationList : [];
        if (translationList.length !== texts.length) {
            throw new Error(`火山引擎返回数量不对：期望 ${texts.length}，实际 ${translationList.length}`);
        }
        return translationList.map((item, index) => {
            const translated = normalizeString(item?.Translation);
            if (!translated) throw new Error(`火山引擎第 ${index + 1} 条返回为空`);
            return translated;
        });
    }

    private _parseResponse(raw: string): VolcengineTranslateResponse {
        try {
            return raw ? JSON.parse(raw) as VolcengineTranslateResponse : {};
        } catch {
            throw new Error(`火山引擎返回了非 JSON 响应：${raw || '<empty>'}`);
        }
    }

    private _buildApiError(error: VolcengineResponseMetadataError, requestId?: string): Error {
        const code = normalizeString(error?.Code);
        const message = normalizeString(error?.Message);
        const requestSuffix = requestId ? `，RequestId: ${requestId}` : '';
        if (code === '-400') return new Error(`火山引擎参数错误：${message || '请检查请求内容'}${requestSuffix}`);
        if (code === '-415') return new Error(`火山引擎不支持这个语向：${message || '请检查语言配置'}${requestSuffix}`);
        if (code === '-429') return new Error(`火山引擎限流：${message || '请求过于频繁'}${requestSuffix}`);
        if (code === '-500' || code.startsWith('-5')) return new Error(`火山引擎内部错误：${message || '请稍后重试'}${requestSuffix}`);
        return new Error(`火山引擎错误 ${code || 'unknown'}：${message || '未知错误'}${requestSuffix}`);
    }

    private _shouldRetry(error: Error): boolean {
        return /火山引擎限流|火山引擎内部错误|HTTP 429|HTTP 5\d{2}/.test(error.message);
    }

    private _sign(accessKeyId: string, secretKey: string, region: string, service: string,
        method: string, uri: string, query: string, payloadHash: string): Record<string, string> {
        const now = new Date();
        const date = now.toISOString().slice(0, 10).replace(/-/g, '');
        const xDate = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
        const headers: Record<string, string> = {
            'Host': VOLCENGINE_HOST,
            'X-Date': xDate,
            'X-Content-Sha256': payloadHash
        };
        const signedHeaderKeys = ['host', 'x-content-sha256', 'x-date'];
        const canonicalHeaders = signedHeaderKeys.map(key => `${key}:${String(headers[this._findHeaderKey(headers, key)]).trim()}\n`).join('');
        const signedHeaders = signedHeaderKeys.join(';');
        const canonicalRequest = [method, uri, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
        const credentialScope = `${date}/${region}/${service}/request`;
        const stringToSign = ['HMAC-SHA256', xDate, credentialScope,
            crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
        let k = crypto.createHmac('sha256', secretKey).update(date).digest();
        k = crypto.createHmac('sha256', k).update(region).digest();
        k = crypto.createHmac('sha256', k).update(service).digest();
        k = crypto.createHmac('sha256', k).update('request').digest();
        const signature = crypto.createHmac('sha256', k).update(stringToSign).digest('hex');
        headers['Authorization'] = `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
        return headers;
    }

    private _findHeaderKey(headers: Record<string, string>, expectedKey: string): string {
        const match = Object.keys(headers).find(key => key.toLowerCase() === expectedKey);
        if (!match) throw new Error(`缺少签名头：${expectedKey}`);
        return match;
    }
}

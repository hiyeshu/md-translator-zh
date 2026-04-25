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

interface OpenAiCompatibleErrorBody {
    message?: string;
    type?: string;
    code?: string;
}

interface OpenAiCompatibleMessagePart {
    type?: string;
    text?: string;
    content?: string;
}

interface OpenAiCompatibleChatCompletionResponse {
    choices?: Array<{
        message?: {
            content?: string | OpenAiCompatibleMessagePart[];
        };
    }>;
    error?: OpenAiCompatibleErrorBody;
}

interface LlmBatchJsonResponse {
    translations?: unknown[];
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
const LLM_DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4/';
const LLM_DEFAULT_MODEL = 'glm-4-flash';
const LLM_MAX_RETRIES = 3;
const LLM_MAX_CONCURRENCY = 3;
const LLM_TEMPERATURE = 0.2;
const LLM_SYSTEM_PROMPT = '你是 Markdown 翻译器。把输入翻成简体中文。只返回译文，不要解释，不要加引号，不要补充说明。保留类似 {{MD0}} 的占位符不变。';
const LLM_BATCH_SYSTEM_PROMPT = '你是 Markdown 翻译器。用户会给你一个 JSON 对象，里面有 texts 数组。把每个元素翻成简体中文，按原顺序返回 JSON 对象 {"translations":["...", "..."]}。translations 长度必须和输入完全一致。不要输出解释，不要输出 Markdown 代码块，不要输出额外字段。保留类似 {{MD0}} 的占位符不变。';
const LLM_BATCH_MAX_ITEMS = 12;
const LLM_BATCH_MAX_TOTAL_CHARS = 6000;

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

function normalizeBaseUrl(value: string, fallback: string): string {
    const normalized = normalizeString(value) || fallback;
    return normalized.replace(/\/+$/, '');
}

function buildOpenAiCompatibleUrl(baseUrl: string): string {
    const normalized = normalizeBaseUrl(baseUrl, LLM_DEFAULT_BASE_URL);
    return /\/chat\/completions$/i.test(normalized) ? normalized : `${normalized}/chat/completions`;
}

function parseJsonResponse<T>(raw: string, providerName: string): T {
    try {
        return raw ? JSON.parse(raw) as T : {} as T;
    } catch {
        throw new Error(`${providerName} 返回了非 JSON 响应：${raw || '<empty>'}`);
    }
}

function extractOpenAiCompatibleText(result: OpenAiCompatibleChatCompletionResponse): string {
    const content = result.choices?.[0]?.message?.content;
    if (typeof content === 'string') {
        return normalizeString(content);
    }
    if (Array.isArray(content)) {
        return normalizeString(content.map(part => normalizeString(part?.text || part?.content)).filter(Boolean).join(''));
    }
    return '';
}

async function requestOpenAiCompatibleTranslation(options: {
    apiKey: string;
    baseUrl: string;
    model: string;
    text: string;
}): Promise<string> {
    const body = JSON.stringify({
        model: options.model,
        messages: [
            { role: 'system', content: LLM_SYSTEM_PROMPT },
            { role: 'user', content: options.text }
        ],
        temperature: LLM_TEMPERATURE,
        stream: false
    });
    const response = await httpsRequest(buildOpenAiCompatibleUrl(options.baseUrl), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${options.apiKey}`
        },
        body
    });
    const raw = await response.text();
    const parsed = parseJsonResponse<OpenAiCompatibleChatCompletionResponse>(raw, 'LLM');
    const apiMessage = normalizeString(parsed.error?.message);
    if (!response.ok) {
        throw new Error(`LLM 请求失败：HTTP ${response.status}${apiMessage ? ` ${apiMessage}` : ''}`);
    }
    if (apiMessage && !parsed.choices?.length) {
        throw new Error(`LLM 请求失败：${apiMessage}`);
    }
    const translated = extractOpenAiCompatibleText(parsed);
    if (!translated) throw new Error('LLM 返回为空');
    return translated;
}

async function requestOpenAiCompatibleBatchTranslation(options: {
    apiKey: string;
    baseUrl: string;
    model: string;
    texts: string[];
}): Promise<string[]> {
    const body = JSON.stringify({
        model: options.model,
        messages: [
            { role: 'system', content: LLM_BATCH_SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify({ texts: options.texts }) }
        ],
        temperature: LLM_TEMPERATURE,
        stream: false,
        response_format: {
            type: 'json_object'
        }
    });
    const response = await httpsRequest(buildOpenAiCompatibleUrl(options.baseUrl), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${options.apiKey}`
        },
        body
    });
    const raw = await response.text();
    const parsed = parseJsonResponse<OpenAiCompatibleChatCompletionResponse>(raw, 'LLM');
    const apiMessage = normalizeString(parsed.error?.message);
    if (!response.ok) {
        throw new Error(`LLM 批量请求失败：HTTP ${response.status}${apiMessage ? ` ${apiMessage}` : ''}`);
    }
    if (apiMessage && !parsed.choices?.length) {
        throw new Error(`LLM 批量请求失败：${apiMessage}`);
    }
    const content = extractOpenAiCompatibleText(parsed);
    if (!content) throw new Error('LLM 批量返回为空');
    const result = parseJsonResponse<LlmBatchJsonResponse>(content, 'LLM 批量');
    if (!Array.isArray(result.translations)) {
        throw new Error('LLM 批量返回缺少 translations 数组');
    }
    if (result.translations.length !== options.texts.length) {
        throw new Error(`LLM 批量返回数量不对：期望 ${options.texts.length}，实际 ${result.translations.length}`);
    }
    return result.translations.map((item, index) => {
        const translated = typeof item === 'string' ? item.trim() : '';
        if (!translated) throw new Error(`LLM 批量第 ${index + 1} 条返回为空`);
        return translated;
    });
}

function chunkLlmBatchTexts(texts: string[]): string[][] {
    const chunks: string[][] = [];
    let currentChunk: string[] = [];
    let currentLength = 0;
    for (const text of texts) {
        const nextLength = text.length;
        const exceedsItemLimit = currentChunk.length >= LLM_BATCH_MAX_ITEMS;
        const exceedsCharLimit = currentLength + nextLength > LLM_BATCH_MAX_TOTAL_CHARS;
        if (currentChunk.length > 0 && (exceedsItemLimit || exceedsCharLimit)) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentLength = 0;
        }
        currentChunk.push(text);
        currentLength += nextLength;
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);
    return chunks;
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
export class LlmTranslateProvider {
    async translate(text: string): Promise<string> {
        const apiKey = normalizeString(getConfigValue('llm.apiKey', ''));
        const baseUrl = normalizeBaseUrl(getConfigValue('llm.baseUrl', LLM_DEFAULT_BASE_URL), LLM_DEFAULT_BASE_URL);
        const model = normalizeString(getConfigValue('llm.model', LLM_DEFAULT_MODEL)) || LLM_DEFAULT_MODEL;
        if (!apiKey) throw new Error('LLM API Key 还没配置');
        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= LLM_MAX_RETRIES; attempt++) {
            try {
                return await requestOpenAiCompatibleTranslation({ apiKey, baseUrl, model, text });
            } catch (error) {
                lastError = error instanceof Error ? error : new Error('LLM 请求失败');
                if (!this._shouldRetry(lastError) || attempt === LLM_MAX_RETRIES) break;
                await sleep(400 * Math.pow(2, attempt - 1));
            }
        }
        throw lastError || new Error('LLM 请求失败');
    }

    async translateBatch(texts: string[]): Promise<string[]> {
        if (texts.length === 0) return [];
        const apiKey = normalizeString(getConfigValue('llm.apiKey', ''));
        const baseUrl = normalizeBaseUrl(getConfigValue('llm.baseUrl', LLM_DEFAULT_BASE_URL), LLM_DEFAULT_BASE_URL);
        const model = normalizeString(getConfigValue('llm.model', LLM_DEFAULT_MODEL)) || LLM_DEFAULT_MODEL;
        if (!apiKey) throw new Error('LLM API Key 还没配置');
        const chunks = chunkLlmBatchTexts(texts);
        const results: string[] = [];
        for (const chunk of chunks) {
            let lastError: Error | null = null;
            for (let attempt = 1; attempt <= LLM_MAX_RETRIES; attempt++) {
                try {
                    const translatedChunk = await requestOpenAiCompatibleBatchTranslation({ apiKey, baseUrl, model, texts: chunk });
                    results.push(...translatedChunk);
                    lastError = null;
                    break;
                } catch (error) {
                    lastError = error instanceof Error ? error : new Error('LLM 批量请求失败');
                    if (!this._shouldRetry(lastError) || attempt === LLM_MAX_RETRIES) break;
                    await sleep(400 * Math.pow(2, attempt - 1));
                }
            }
            if (lastError) throw lastError;
        }
        return results;
    }

    async getQuota(): Promise<QuotaInfo> {
        try {
            await this.translate('hello');
            return { resetDate: '请去对应 LLM 平台查看实际用量', error: '' };
        } catch (error) {
            return { error: error instanceof Error ? error.message : '连接失败' };
        }
    }

    private _shouldRetry(error: Error): boolean {
        return /HTTP 429|HTTP 5\d{2}|timeout|timed out|ECONNRESET|ENOTFOUND|socket hang up/i.test(error.message);
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

export type ConfigCacheAdapter = {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem?(key: string): void | Promise<void>;
};
export type GameClientOptions = {
  baseUrl: string;
  gameId: string;
  apiKey?: string;
  configCache?: ConfigCacheAdapter;
  fetch?: typeof globalThis.fetch;
};
export type Archive<T = unknown> = { id: string; slot: string; data: T; version: number; updated_at: string };
export type PublishedConfig<T = unknown> = { value: T; version: number; updated_at: string };
export type TrackingEvent = {
  eventKey: string;
  properties?: Record<string, unknown>;
  occurredAt?: string;
  idempotencyKey?: string;
};
export type TrackingResult = {
  accepted: number;
  duplicated: number;
  rejected: number;
  results: Array<{
    index: number;
    eventKey: string;
    status: 'accepted' | 'duplicated' | 'rejected';
    code?: string;
    message?: string;
  }>;
};

export class GameDataError extends Error {
  constructor(message: string, readonly status: number, readonly current?: unknown) { super(message); }
}

export class GameDataClient {
  private userToken?: string;
  constructor(private readonly options: GameClientOptions) {}

  private request(input: string, init?: RequestInit): Promise<Response> {
    return (this.options.fetch || globalThis.fetch)(input, init);
  }

  private gameHeaders(): Record<string, string> {
    if (!this.options.apiKey) throw new Error('该操作需要服务端 API Key');
    return { 'Content-Type': 'application/json', 'X-Game-Id': this.options.gameId, 'X-Api-Key': this.options.apiKey };
  }

  private userHeaders(): Record<string, string> {
    if (!this.userToken) throw new Error('请先创建用户会话或设置 userToken');
    return { Authorization: `Bearer ${this.userToken}` };
  }

  private async result<T>(response: Response): Promise<T> {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new GameDataError(data.error || `HTTP ${response.status}`, response.status, data.current);
    return data as T;
  }

  private cacheKey(path: string): string {
    return `syncdepot:config:${this.options.baseUrl}:${this.options.gameId}:${path}`;
  }

  private async cachedConfigResult<T>(path: string, headers: Record<string, string>): Promise<T> {
    const key = this.cacheKey(path);
    let cached: { etag?: string; value: T } | null = null;
    if (this.options.configCache) {
      try {
        const raw = await this.options.configCache.getItem(key);
        if (raw) cached = JSON.parse(raw) as { etag?: string; value: T };
      } catch {
        cached = null;
      }
    }
    const requestHeaders = { ...headers, ...(cached?.etag ? { 'If-None-Match': cached.etag } : {}) };
    try {
      const response = await this.request(`${this.options.baseUrl}${path}`, { headers: requestHeaders });
      if (response.status === 304 && cached) return cached.value;
      if (!response.ok && cached && [502, 503, 504].includes(response.status)) return cached.value;
      const value = await this.result<T>(response);
      if (this.options.configCache) {
        const etag = response.headers.get('etag') || undefined;
        try {
          await this.options.configCache.setItem(key, JSON.stringify({ ...(etag ? { etag } : {}), value }));
        } catch {
          // 缓存是容错优化；存储配额、隐私模式等错误不能覆盖已经成功取得的网络结果。
        }
      }
      return value;
    } catch (error) {
      if (cached && !(error instanceof GameDataError)) return cached.value;
      throw error;
    }
  }

  async getConfigs(environment = 'production'): Promise<Record<string, { value: unknown; version: number }>> {
    const path = `/api/client/configs?environment=${encodeURIComponent(environment)}`;
    return (await this.cachedConfigResult<{ configs: Record<string, { value: unknown; version: number }> }>(path, this.gameHeaders())).configs;
  }

  async getUserConfigs(environment = 'production'): Promise<Record<string, PublishedConfig>> {
    const path = `/api/client/me/configs?environment=${encodeURIComponent(environment)}`;
    return (await this.cachedConfigResult<{ configs: Record<string, PublishedConfig> }>(path, this.userHeaders())).configs;
  }

  async getUserConfig<T = unknown>(key: string, environment = 'production'): Promise<PublishedConfig<T>> {
    const path = `/api/client/me/configs/${encodeURIComponent(key)}?environment=${encodeURIComponent(environment)}`;
    return this.cachedConfigResult<PublishedConfig<T>>(path, this.userHeaders());
  }

  async startSession(provider: string, credential: string): Promise<string> {
    const response = await this.request(`${this.options.baseUrl}/api/client/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Game-Id': this.options.gameId },
      body: JSON.stringify({ provider, credential }),
    });
    const result = await this.result<{ user_token: string }>(response);
    this.userToken = result.user_token;
    return result.user_token;
  }

  /** 使用后台为当前游戏生成的测试账号登录，Token 可调用全部 /api/client/me/* 接口。 */
  async startTestSession(username: string, password: string): Promise<string> {
    const response = await this.request(`${this.options.baseUrl}/api/client/test-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Game-Id': this.options.gameId },
      body: JSON.stringify({ username, password }),
    });
    const result = await this.result<{ user_token: string }>(response);
    this.userToken = result.user_token;
    return result.user_token;
  }

  async resolveTrustedUser(input: { openid?: string; user_id?: string; profile?: Record<string, unknown> }): Promise<string> {
    const response = await this.request(`${this.options.baseUrl}/api/client/users/resolve`, { method: 'POST', headers: this.gameHeaders(), body: JSON.stringify(input) });
    const result = await this.result<{ user_token: string }>(response);
    this.userToken = result.user_token;
    return result.user_token;
  }

  /** @deprecated 公开客户端请使用 startSession；此方法只供持有服务端 Key 的可信环境调用。 */
  async resolveUser(input: { openid?: string; user_id?: string; profile?: Record<string, unknown> }): Promise<string> {
    return this.resolveTrustedUser(input);
  }

  setUserToken(token: string): void { this.userToken = token; }

  async trackEvent(
    eventKey: string,
    properties: Record<string, unknown> = {},
    options: { occurredAt?: string; idempotencyKey?: string } = {},
  ): Promise<TrackingResult> {
    return this.trackEvents([{ eventKey, properties, ...options }]);
  }

  async trackEvents(events: TrackingEvent[]): Promise<TrackingResult> {
    const payload = events.map(event => ({
      event_key: event.eventKey,
      properties: event.properties || {},
      occurred_at: event.occurredAt || new Date().toISOString(),
      idempotency_key: event.idempotencyKey || globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }));
    const response = await this.request(`${this.options.baseUrl}/api/client/me/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.userHeaders() },
      body: JSON.stringify({ events: payload }),
    });
    return this.result(response);
  }

  async loadArchive<T>(slot = 'default'): Promise<Archive<T> | null> {
    const response = await this.request(`${this.options.baseUrl}/api/client/me/archives/${encodeURIComponent(slot)}`, { headers: this.userHeaders() });
    return this.result<Archive<T> | null>(response);
  }

  async saveArchive<T>(slot: string, data: T, version?: number, options: { idempotencyKey?: string } = {}): Promise<Archive<T>> {
    const idempotencyKey = options.idempotencyKey || globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const init: RequestInit = {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...this.userHeaders(), 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ data, version }),
    };
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await this.request(`${this.options.baseUrl}/api/client/me/archives/${encodeURIComponent(slot)}`, init);
        if (![502, 503, 504].includes(response.status) || attempt === 1) break;
      } catch (error) {
        if (attempt === 1) throw error;
      }
    }
    if (!response) throw new Error('存档请求未完成');
    return this.result<Archive<T>>(response);
  }

  /** 支持 pako 的二进制字符串或 Base64；服务端会原样返回，不解析内部字段。 */
  async saveCompressedArchive(
    slot: string,
    compressedData: string,
    version?: number,
    options: { idempotencyKey?: string } = {},
  ): Promise<Archive<string>> {
    return this.saveArchive(slot, compressedData, version, options);
  }

  async loadCompressedArchive(slot = 'default'): Promise<Archive<string> | null> {
    return this.loadArchive<string>(slot);
  }

  async deleteArchive(slot = 'default'): Promise<{ deleted: true }> {
    const response = await this.request(`${this.options.baseUrl}/api/client/me/archives/${encodeURIComponent(slot)}`, {
      method: 'DELETE',
      headers: this.userHeaders(),
    });
    return this.result<{ deleted: true }>(response);
  }
}

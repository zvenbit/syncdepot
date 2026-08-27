export type GameClientOptions = { baseUrl: string; gameId: string; apiKey?: string };
export type Archive<T = unknown> = { id: string; slot: string; data: T; version: number; updated_at: string };
export type TrackingEvent = {
  eventKey: string;
  properties?: Record<string, unknown>;
  occurredAt?: string;
  idempotencyKey?: string;
};

export class GameDataError extends Error {
  constructor(message: string, readonly status: number, readonly current?: unknown) { super(message); }
}

export class GameDataClient {
  private userToken?: string;
  constructor(private readonly options: GameClientOptions) {}

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

  async getConfigs(environment = 'production'): Promise<Record<string, { value: unknown; version: number }>> {
    const response = await fetch(`${this.options.baseUrl}/api/client/configs?environment=${encodeURIComponent(environment)}`, { headers: this.gameHeaders() });
    return (await this.result<{ configs: Record<string, { value: unknown; version: number }> }>(response)).configs;
  }

  async startSession(provider: string, credential: string): Promise<string> {
    const response = await fetch(`${this.options.baseUrl}/api/client/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Game-Id': this.options.gameId },
      body: JSON.stringify({ provider, credential }),
    });
    const result = await this.result<{ user_token: string }>(response);
    this.userToken = result.user_token;
    return result.user_token;
  }

  async resolveTrustedUser(input: { openid?: string; user_id?: string; profile?: Record<string, unknown> }): Promise<string> {
    const response = await fetch(`${this.options.baseUrl}/api/client/users/resolve`, { method: 'POST', headers: this.gameHeaders(), body: JSON.stringify(input) });
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
  ): Promise<{ accepted: number; duplicated: number }> {
    return this.trackEvents([{ eventKey, properties, ...options }]);
  }

  async trackEvents(events: TrackingEvent[]): Promise<{ accepted: number; duplicated: number }> {
    const payload = events.map(event => ({
      event_key: event.eventKey,
      properties: event.properties || {},
      occurred_at: event.occurredAt,
      idempotency_key: event.idempotencyKey || globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }));
    const response = await fetch(`${this.options.baseUrl}/api/client/me/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.userHeaders() },
      body: JSON.stringify({ events: payload }),
    });
    return this.result(response);
  }

  async loadArchive<T>(slot = 'default'): Promise<Archive<T>> {
    const response = await fetch(`${this.options.baseUrl}/api/client/me/archives/${encodeURIComponent(slot)}`, { headers: this.userHeaders() });
    return this.result<Archive<T>>(response);
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
        response = await fetch(`${this.options.baseUrl}/api/client/me/archives/${encodeURIComponent(slot)}`, init);
        if (![502, 503, 504].includes(response.status) || attempt === 1) break;
      } catch (error) {
        if (attempt === 1) throw error;
      }
    }
    if (!response) throw new Error('存档请求未完成');
    return this.result<Archive<T>>(response);
  }
}

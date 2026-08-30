import type {
  PlatformCredentialVerifier,
  VerifiedIdentity,
} from '../modules/identity.js';

export type WechatCredentialVerifierOptions = {
  appId: string;
  appSecret: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

type WechatCode2SessionResponse = {
  openid?: string;
  session_key?: string;
  unionid?: string;
  errcode?: number;
  errmsg?: string;
};

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

function throwForWechatError(errcode: number | undefined): void {
  if (errcode === undefined || errcode === 0) return;
  if ([40029, 40163].includes(errcode)) throw fail(401, '微信登录凭证无效，请重新登录');
  if (errcode === 45011) throw fail(429, '微信登录请求过于频繁，请稍后重试');
  if (errcode === -1) throw fail(503, '微信登录暂时不可用');
  if ([40013, 40125, 40164, 41002, 41004].includes(errcode)) throw fail(503, '微信登录配置不可用');
  throw fail(502, '微信登录验证失败');
}

export function createWechatCredentialVerifier(
  options: WechatCredentialVerifierOptions,
): PlatformCredentialVerifier {
  const request = options.fetch || globalThis.fetch;

  return {
    async verify(input): Promise<VerifiedIdentity> {
      if (input.provider !== 'wechat') throw fail(400, '不支持的平台身份类型');
      const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
      url.search = new URLSearchParams({
        appid: options.appId,
        secret: options.appSecret,
        js_code: input.credential,
        grant_type: 'authorization_code',
      }).toString();
      let response: Response;
      try {
        response = await request(url, {
          signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
        });
      } catch {
        throw fail(503, '微信登录暂时不可用');
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw fail(502, '微信登录响应无效');
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw fail(502, '微信登录响应无效');
      const data = payload as WechatCode2SessionResponse;
      throwForWechatError(data.errcode);
      if (!response.ok) {
        if (response.status === 429) throw fail(429, '微信登录请求过于频繁，请稍后重试');
        if (response.status >= 500) throw fail(503, '微信登录暂时不可用');
        throw fail(502, '微信登录验证失败');
      }
      if (typeof data.openid !== 'string' || !data.openid.trim()) throw fail(502, '微信登录响应无效');
      return {
        subject: data.openid.trim(),
        ...(typeof data.unionid === 'string' && data.unionid.trim() ? { externalUserId: data.unionid.trim() } : {}),
      };
    },
  };
}

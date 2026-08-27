import crypto from 'node:crypto';

export type TokenPayload = {
  sub: string;
  username?: string;
  role?: 'admin' | 'viewer';
  exp?: number;
  [key: string]: unknown;
};

export const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

export function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')): string {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [, salt, expected] = String(encoded).split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

const b64url = (input: string): string => Buffer.from(input).toString('base64url');

export function signToken(payload: TokenPayload, secret: string, ttlSeconds = 8 * 3600): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

export function verifyToken(token: string | undefined, secret: string): TokenPayload | null {
  const [header, body, signature] = String(token || '').split('.');
  if (!header || !body || !signature) return null;
  const actual = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest();
  const supplied = Buffer.from(signature, 'base64url');
  if (actual.length !== supplied.length || !crypto.timingSafeEqual(actual, supplied)) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenPayload;
  return typeof payload.exp === 'number' && payload.exp > Date.now() / 1000 ? payload : null;
}

export const newApiKey = () => `gk_${crypto.randomBytes(24).toString('base64url')}`;

export function requiredString(value: unknown, field: string, max = 191): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    const error = new Error(`${field} 必须是 1-${max} 位字符串`) as Error & { statusCode: number };
    error.statusCode = 400;
    throw error;
  }
  return value.trim();
}

export function optionalJson<T = Record<string, unknown>>(value: T | undefined, fallback = {} as T): T {
  return value === undefined ? fallback : value;
}

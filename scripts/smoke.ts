import crypto from 'node:crypto';

if (process.loadEnvFile) process.loadEnvFile('.env');
const baseUrl = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:8080';
let adminToken = '';
let gameId = '';

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(baseUrl + path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${init.method || 'GET'} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data as T;
}

try {
  const login = await call<{ token: string }>('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }) });
  adminToken = login.token;
  const adminHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` };
  const gameKey = `smoke_${Date.now()}`;
  const created = await call<{ id: string; api_key: string }>('/api/admin/games', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ game_key: gameKey, name: '自动验收项目', description: '完成后自动删除' }) });
  gameId = created.id;
  const gameHeaders = { 'Content-Type': 'application/json', 'X-Game-Id': gameKey, 'X-Api-Key': created.api_key };

  const config = await call<{ id: string }>('/api/admin/games/' + gameId + '/configs', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ config_key: 'global', value: { enabled: true } }) });
  await call('/api/client/configs', { headers: gameHeaders });
  const user = await call<{ user_token: string }>('/api/client/users/resolve', { method: 'POST', headers: gameHeaders, body: JSON.stringify({ user_id: 'smoke-user' }) });
  const userHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${user.user_token}`, 'Idempotency-Key': crypto.randomUUID() };
  const archive = await call<{ version: number }>('/api/client/me/archives/default', { method: 'PUT', headers: userHeaders, body: JSON.stringify({ data: { level: 1 } }) });
  await call('/api/client/me/archives/default', { headers: { Authorization: `Bearer ${user.user_token}` } });
  await call('/api/client/me/archives/default', { method: 'PUT', headers: { ...userHeaders, 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ version: archive.version, data: { level: 2 } }) });
  await call('/api/admin/configs/' + config.id + '/history', { headers: adminHeaders });
  await call('/api/admin/games/' + gameId + '/metrics', { headers: adminHeaders });
  console.log('smoke test passed: auth, config, user token, archive, history, metrics');
} finally {
  if (gameId && adminToken) {
    await fetch(`${baseUrl}/api/admin/games/${gameId}?confirm=DELETE`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } });
  }
}

import { query, pool } from '../src/db.js';
import { hashPassword } from '../src/lib.js';

const username = process.argv[2] || process.env.ADMIN_USERNAME;
const password = process.argv[3] || process.env.ADMIN_PASSWORD;
if (!username || !password || password.length < 10) throw new Error('用法: npm run create-admin -- <用户名> <至少10位密码>');
await query(`INSERT INTO admins(username,password_hash) VALUES($1,$2)
  ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash, updated_at=now()`, [username, hashPassword(password)]);
console.log(`管理员 ${username} 已创建/更新`);
await pool.end();

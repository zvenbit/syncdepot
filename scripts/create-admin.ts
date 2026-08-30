import { query, pool } from '../src/db.js';
import { hashPassword } from '../src/lib.js';

const username = process.argv[2] || process.env.ADMIN_USERNAME;
const password = process.argv[3] || process.env.ADMIN_PASSWORD;
if (!username || !password || password.length < 10) throw new Error('用法: npm run create-admin -- <用户名> <至少10位密码>');
await query(`INSERT INTO admins(username,password_hash,must_change_password) VALUES($1,$2,true)
  ON CONFLICT(username) DO UPDATE SET
    password_hash=excluded.password_hash,must_change_password=true,
    token_version=admins.token_version+1,updated_at=now()`, [username, hashPassword(password)]);
console.log(`管理员 ${username} 已创建/更新，首次登录必须修改密码`);
await pool.end();

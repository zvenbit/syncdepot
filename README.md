# 游戏数据中心

面向多个小游戏/项目的统一配置、云存档与运营数据服务。每条配置、用户、存档和运营事件都绑定 `game_id`，支持分权 API Key、平台身份凭证、用户短期 Token、JSON Schema 配置校验、配置发布回滚、存档历史恢复、游戏级 RBAC、审计和运营指标。

## 技术选型

- **TypeScript / Node.js 20+ / Fastify**：严格类型检查，接口层轻量，适合 I/O 密集型游戏后台；单体起步，后续可无状态扩容。
- **PGlite（本地）/ PostgreSQL 16（生产）**：本地默认将兼容 PostgreSQL 的嵌入式数据库保存在项目文件中，无需 Docker 和 5432 服务；生产通过 `DATABASE_URL` 无缝切换外部 PostgreSQL。JSONB 同时支持灵活的游戏差异和事务、唯一约束、索引。
- **原生管理后台**：由服务直接托管，无额外前端构建链；当前包含游戏概览、运营数据、配置、玩家和存档管理。
- **Docker Compose**：本地和单机部署开箱即用。生产建议使用云 PostgreSQL、HTTPS 网关及密钥服务。

## 数据模型

```text
games 1 ── N game_configs
  │
  ├── N game_users 1 ── N user_archives
  │
  └── N game_event_definitions 1 ── N game_events
```

- `games.game_key` 是客户端发送的游戏 ID；一个游戏可创建多个有权限范围的 API Key，Key 仅保存 SHA-256 摘要。
- `game_configs` 由 `game_id + environment + config_key` 唯一确定，更新自动递增版本。
- `game_users` 支持 OpenID、业务用户 ID 或二者同时存在，均按游戏隔离。
- `user_archives` 支持一个玩家多个 `slot`，使用 `version` 乐观锁、历史快照和幂等键防止并发及重试覆盖。
- `user_identities` 将微信、渠道账号等平台身份映射到游戏用户；平台凭证由可替换的身份验证适配器验证。
- `game_memberships` 以 `viewer`、`editor`、`owner` 控制全局只读账号对单个游戏的权限。
- `game_event_definitions` 维护每个项目允许上报的事件；`game_events` 保存玩家、会话、发生时间、属性和幂等键，并提供 7–90 天汇总。
- 配置草稿修订号与线上发布版本分离；无论按什么顺序发布草稿，线上版本都严格递增。

## 本地启动（无需 Docker）

复制环境变量并修改 `JWT_SECRET` 和管理员密码，然后执行：

```bash
cp .env.example .env
npm install
npm run migrate
npm run create-admin -- admin 'your-strong-password'
npm run dev
```

打开 <http://localhost:8080>。本地数据默认写入 `.data/game-center`；`npm run dev` 使用 `tsx` 直接运行 TypeScript，不会启动 Docker 或独立 PostgreSQL 进程。生产构建使用 `npm run build && npm start`。

设置了 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 时，服务每次启动都会将该管理员密码同步为 `.env` 中的值；开发环境修改密码后重启服务即可生效。

如果 `.env` 中存在 `DATABASE_URL`，服务会自动使用该外部 PostgreSQL；没有该变量时自动使用 PGlite。Docker Compose 仅作为以后部署选项保留，不是本地开发必需项。

健康检查：`GET /health`。

## 从 1.x 升级到 2.0

```bash
npm install
npm run migrate
```

`003_sync_core_upgrade.sql` 会保留原有配置和存档，回填发布版本，新增配置 Schema、平台身份、游戏成员、共享限流及幂等过期字段。迁移器会校验已应用文件的 SHA-256，并在 PostgreSQL 上使用 advisory lock，避免多个实例同时迁移。升级前仍建议先备份生产数据库。

升级到 2.1 时，`004_operational_analytics.sql` 会新增项目运营事件表。升级到 2.2 时，`005_project_defined_events.sql` 会移除从未产生数据的旧示例事件；已经有历史数据的事件会保留为普通项目事件，避免丢失统计信息。

使用本地 PGlite 时不要在开发服务运行期间从另一个进程执行迁移；手工升级请严格按“停止 `npm run dev` → 执行 `npm run migrate` → 重新启动”的顺序。现在直接执行 `npm run dev` 会先自动运行迁移，避免遗漏新表。

## 客户端接入

新建或新增密钥时后台只显示一次 API Key。配置请求需要具有 `config:read` 权限，并携带：

```http
X-Game-Id: puzzle_01
X-Api-Key: gk_xxxxxxxxx
Content-Type: application/json
```

主要接口：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/client/configs?environment=production` | 获取游戏的全部配置 |
| GET | `/api/client/configs/:key` | 获取单项配置 |
| POST | `/api/client/users/resolve` | 解析用户并签发两小时用户 Token |
| POST | `/api/client/session` | 验证平台凭证并签发两小时用户 Token |
| POST | `/api/client/me/events` | 使用用户 Token 批量上报运营打点 |
| POST | `/api/client/events` | 使用 `analytics:write` 服务端 Key 代玩家上报 |
| GET | `/api/client/me/archives/:slot` | 使用用户 Token 读取自己的存档 |
| PUT | `/api/client/me/archives/:slot` | 使用用户 Token 新建或更新自己的存档 |
| DELETE | `/api/client/me/archives/:slot` | 删除自己的存档 |

公开客户端推荐使用平台登录凭证，不携带服务端 API Key：

```http
POST /api/client/session
X-Game-Id: puzzle_01
Content-Type: application/json

{"provider":"wechat","credential":"平台临时登录凭证"}
```

服务端设置 `PLATFORM_IDENTITY_WEBHOOK_URL` 后，系统会把 `gameKey`、`provider`、`credential` POST 到该可信身份服务。验证服务返回：

```json
{"subject":"平台稳定用户标识","externalUserId":"可选业务账号","profile":{"nickname":"玩家A"}}
```

可信业务服务也可以继续使用带 `user:resolve` 权限的 API Key 创建/解析玩家：

```json
{"openid":"wx-openid","user_id":"account-1001","profile":{"nickname":"玩家A"}}
```

两种方式都会返回 `user_token`，后续请求使用 `Authorization: Bearer <user_token>`。保存存档时建议携带唯一的 `Idempotency-Key`；SDK 会在一次网络重试中复用同一个 Key，也允许调用方持久化并显式传入。首次保存可省略 `version`，更新时必须传读取到的版本，冲突响应同时返回当前存档：

```json
{"version":3,"data":{"level":12,"coins":880,"inventory":["sword"]}}
```

每个项目在“运营数据”页独立维护自己的事件名称、`event_key`、分类和说明，没有系统固定事件。事件可以编辑、启停；尚无历史数据的定义可以删除。单次最多上报 100 条，`idempotency_key` 用于过滤网络重试产生的重复事件：

```ts
await client.trackEvent('level_start', { level: 12 });
await client.trackEvent('level_complete', { level: 12, stars: 3 });
```

服务端也可向 `/api/client/events` 批量上报，此时 API Key 必须包含 `analytics:write`，且每条事件需提供 `user_id` 或 `session_id`。

## 管理接口

后台页面使用 `/api/admin/*`。登录后以 Bearer Token 调用，包含：项目设置、运营打点定义与趋势、多 API Key 与权限、配置 Schema/草稿/发布/回滚、批量导入导出、玩家搜索、存档历史恢复、审计日志、指标和告警。全局 `admin` 可访问全部游戏；全局 `viewer` 只看到已加入的游戏，其游戏角色可以是 `viewer`、`editor` 或 `owner`。删除游戏必须显式传 `?confirm=DELETE`。

机器可读接口文档位于 `/openapi.json`，TypeScript/Cocos SDK 位于 `/sdk/game-client.ts`。端到端验收可在服务启动后运行 `npm run smoke`。

## 上线前清单

- 将示例数据库/JWT/管理员密码全部替换，通过 HTTPS 暴露服务。
- API Key 不要放进可反编译的公开客户端；微信小游戏等场景应由可信业务服务转调，或增加平台登录凭证校验。
- 为 PostgreSQL 设置自动备份与时间点恢复；配置数据库连接上限和告警。
- 根据流量在网关增加限流，服务可启动多个副本；热点配置再引入 Redis/CDN 缓存。
- 多副本部署将 `RATE_LIMIT_STORE` 设为 `database` 以共享限流计数；请求指标先在进程内短暂聚合，再批量写入数据库。
- 幂等记录和过期限流桶会自动清理；`AUDIT_RETENTION_DAYS=0` 永久保留审计，也可以设置保留天数。
- 如涉及付费或关键资产，存档写入必须增加服务端业务校验，不能直接信任客户端 JSON。

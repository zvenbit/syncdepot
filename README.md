# 多项目数据中心

面向游戏、APP、小程序、网站和服务端项目的统一配置、云存档与运营数据服务。每条配置、用户、存档和运营事件都绑定内部 `game_id`，不同项目的数据严格隔离。系统支持分权 API Key、平台身份凭证、项目测试账号、用户短期 Token、首次登录强制改密、JSON Schema 配置校验、配置定时/批量发布与回滚、存档历史恢复、项目级 RBAC、通用属性分析、关卡结果与疑似卡关分析、审计和运行指标。

## 技术选型

- **TypeScript / Node.js 20.12+ / Fastify**：严格类型检查，接口层轻量，适合 I/O 密集型项目后台；单体起步，后续可无状态扩容。
- **PGlite（本地）/ PostgreSQL 16（生产）**：本地默认将兼容 PostgreSQL 的嵌入式数据库保存在项目文件中，无需 Docker 和 5432 服务；生产通过 `DATABASE_URL` 切换外部 PostgreSQL。JSONB 同时支持灵活的项目差异和事务、唯一约束、索引。
- **原生管理后台**：由服务直接托管，无额外前端构建链；项目内提供“概览、运营、配置、存档”四个可互相切换的页面。CSS 和功能脚本已拆分，开发模式修改后无需重启服务即可读取最新静态资源。
- **可选 Docker 部署**：仓库保留 Dockerfile 和 Compose 配置，但本地开发默认直接使用 Node.js 与 PGlite。

## 数据模型

```text
games 1 ── N game_configs
  │
  ├── N game_users 1 ── N user_archives
  │       └── 0..1 game_test_accounts
  │
  └── N game_event_definitions 1 ── N game_events
                                  └── 0..1 level_result_events
```

- `games.game_key` 是历史兼容字段，也是客户端发送的项目 ID；`project_type` 可选 `game`、`app`、`mini_program`、`website`、`server` 或 `other`。一个项目可创建多个有权限范围的 API Key，Key 仅保存 SHA-256 摘要，当前不设置有效期。
- `game_configs` 由 `game_id + environment + config_key` 唯一确定，更新自动递增版本。
- `game_users` 支持 OpenID、业务用户 ID 或二者同时存在，均按项目隔离。
- `game_test_accounts` 为单个项目绑定独立测试玩家和密码，只用于换取普通玩家 Token；密码只保存 scrypt 摘要。
- `user_archives` 支持一个玩家多个 `slot`，使用 `version` 乐观锁、历史快照和幂等键防止并发及重试覆盖。
- `user_identities` 将微信、渠道账号等平台身份映射到项目用户；平台凭证由可替换的身份验证适配器验证。
- `game_memberships` 以 `viewer`、`editor`、`owner` 控制成员对单个项目的权限。
- `game_event_definitions` 维护每个项目允许上报的事件和分析方式：`count` 普通计数、`property` 通用属性分析、`level_result` 关卡结果分析。`game_events` 保存玩家、会话、发生时间、任意 JSON 属性和幂等键，并提供 7–90 天汇总；`level_result_events` 额外保存通过强校验的关卡成功/失败结果。
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

打开 <http://localhost:8080>。默认监听 `0.0.0.0:8080`，同一局域网也可通过 `http://本机IP:8080` 访问。本地数据默认写入 `.data/game-center`；`npm run dev` 使用 `tsx watch` 直接运行 TypeScript，不会启动 Docker 或独立 PostgreSQL 进程。服务端 TypeScript 变化会自动重启，后台 CSS/JS 由开发环境按请求读取，修改后刷新浏览器即可看到结果。生产构建使用 `npm run build && npm start`。

设置了 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 时，只会在账号不存在时创建一次临时管理员，不会在重启时覆盖后台修改过的密码。使用 `create-admin` 创建或重置的账号，以及后台新建的账号，首次登录必须修改临时密码；修改或重置密码后旧登录令牌立即失效。

如果 `.env` 中存在 `DATABASE_URL`，服务会自动使用该外部 PostgreSQL；没有该变量时自动使用 PGlite。Docker Compose 仅作为以后部署选项保留，不是本地开发必需项。

健康检查：`GET /health`。

### Docker Compose 部署

Compose 不再内置数据库、JWT 或管理员示例密码，也不会把 PostgreSQL 的 `5432` 端口暴露到宿主机。部署前在不会提交到 Git 的 `.env` 中设置：

```dotenv
POSTGRES_PASSWORD=replace-with-a-strong-database-password
DATABASE_URL=postgres://game_admin:replace-with-url-encoded-password@postgres:5432/game_center
JWT_SECRET=replace-with-a-random-secret-at-least-32-characters
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-temporary-password-at-least-10-characters
```

然后执行 `docker compose up --build`。`DATABASE_URL` 中的密码必须与 `POSTGRES_PASSWORD` 一致，且其中的特殊字符需要进行 URL 编码。项目通过 `.dockerignore` 排除 `.env`、本地 PGlite 数据、Git 历史、私钥和证书，避免它们进入 Docker 构建上下文。

### 关键环境变量

| 变量 | 默认值 | 作用 |
|---|---:|---|
| `HOST` / `PORT` | `0.0.0.0` / `8080` | 服务监听地址和端口 |
| `JWT_SECRET` | 仅开发示例值 | 服务端签发管理员和玩家 Token 的密钥；生产至少 32 位且必须稳定保存，不是游戏端配置 |
| `CLIENT_CORS_ORIGINS` | 空 | 允许浏览器客户端跨域访问的精确来源，多个来源用英文逗号分隔，不允许 `*` |
| `CREDENTIAL_ENCRYPTION_KEY` | 空 | 加密各项目在后台保存的微信 AppSecret 等平台凭证；服务级配置，不下发客户端 |
| `TRUST_PROXY` | `false` | 仅在服务位于可信反向代理后时开启，用于正确识别客户端 IP 和协议 |
| `BODY_LIMIT` | `1048576` | 单次 HTTP 请求体上限，单位为字节 |
| `ARCHIVE_SIZE_LIMIT` | `262144` | 单个存档序列化后的上限，单位为字节；不限制存档内部字段 |
| `RATE_LIMIT_STORE` | `memory` | 单实例使用 `memory`；多实例部署使用 `database` 共享限流计数 |

例如浏览器项目运行在 `http://localhost:7456` 时，需要配置：

```dotenv
CLIENT_CORS_ORIGINS=http://localhost:7456
```

白名单必须包含浏览器实际显示的完整来源；`localhost`、`127.0.0.1` 和局域网 IP 是三个不同来源。预检请求支持 `GET`、`HEAD`、`POST`、`PUT`、`DELETE`、`OPTIONS` 以及 `Authorization`、`Content-Type`、`Idempotency-Key`、`If-None-Match`、`X-Game-Id`、`X-Api-Key` 请求头。

## 从 1.x 升级到 2.0

```bash
npm install
npm run migrate
```

`003_sync_core_upgrade.sql` 会保留原有配置和存档，回填发布版本，新增配置 Schema、平台身份、游戏成员、共享限流及幂等过期字段。迁移器会校验已应用文件的 SHA-256，并在 PostgreSQL 上使用 advisory lock，避免多个实例同时迁移。升级前仍建议先备份生产数据库。

升级到 2.1 时，`004_operational_analytics.sql` 会新增项目运营事件表。升级到 2.2 时，`005_project_defined_events.sql` 会移除从未产生数据的旧示例事件；已经有历史数据的事件会保留为普通项目事件，避免丢失统计信息。2.3 新增微信 `code2Session` Adapter、玩家 Token 配置读取接口，以及 `006_game_platform_credentials.sql` 项目级平台凭证表。2.4 通过 `007`–`009` 迁移新增首次登录改密、账号令牌版本、旧关卡进度设置和配置定时发布字段。2.5 的 `010_game_test_accounts.sql` 新增项目级测试账号；`013_level_result_analytics.sql` 将旧最高进度定义直接迁移为关卡结果定义，并从迁移时间开始采集强类型结果；`014_project_types.sql` 为已有项目回填 `game` 类型并加入可编辑的项目类型。旧原始事件保留但不会伪造为成功或失败记录。

已经执行过的迁移文件不可修改，包括空格和末尾换行；迁移器会校验文件摘要。需要调整数据库结构时必须新增更高编号迁移。

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
| GET | `/api/client/configs?environment=production` | 获取项目的全部配置 |
| GET | `/api/client/configs/:key` | 获取单项配置 |
| POST | `/api/client/users/resolve` | 解析用户并签发两小时用户 Token |
| POST | `/api/client/test-session` | 使用项目测试账号签发两小时用户 Token |
| POST | `/api/client/session` | 验证平台凭证并签发两小时用户 Token |
| GET | `/api/client/me/configs?environment=production` | 使用用户 Token 获取所属项目的全部配置 |
| GET | `/api/client/me/configs/:key` | 使用用户 Token 获取所属项目的单项配置 |
| POST | `/api/client/me/events` | 使用用户 Token 批量上报运营打点 |
| POST | `/api/client/events` | 使用 `analytics:write` 服务端 Key 代玩家上报 |
| GET | `/api/client/me/archives/:slot` | 使用用户 Token 读取自己的存档 |
| PUT | `/api/client/me/archives/:slot` | 使用用户 Token 新建或更新自己的存档 |
| DELETE | `/api/client/me/archives/:slot` | 删除自己的存档 |

### 本地测试玩家账号

进入“项目概览 → 测试玩家账号”生成账号，密码只显示一次。测试客户端不需要 API Key，只需项目的 `game_key`、测试账号和密码：

```http
POST /api/client/test-session
X-Game-Id: puzzle_01
Content-Type: application/json

{"username":"local_tester","password":"<后台生成的密码>"}
```

返回的 `user_token` 与真实玩家 Token 权限一致，可读取 `development`、`staging` 或 `production` 配置，并调用当前玩家的存档和打点接口。SDK 会自动保存 Token：

```ts
const client = new GameDataClient({ baseUrl: 'http://127.0.0.1:8080', gameId: 'puzzle_01' });
await client.startTestSession('local_tester', '<后台生成的密码>');
const configs = await client.getUserConfigs('development');
await client.saveArchive('default', { level: 1 });
await client.trackEvent('level_start', { level: 1 });
```

测试账号严格按项目隔离。重置密码或停用账号会立即使已经签发的测试 Token 失效；账号列表和接口都不会再次返回密码或密码摘要。测试账号产生的存档、打点和关联存档幂等记录可以在项目概览中一键清空。运营数据默认排除测试账号，只有主动勾选“包含测试账号数据”时才进入事件、属性和关卡统计，避免联调数据污染正式指标。

微信小游戏调用 `wx.login()` 取得一次性 `code`，只把该 code 发送给后台，不携带服务端 API Key，也不能直接提交客户端伪造的 OpenID：

```http
POST /api/client/session
X-Game-Id: puzzle_01
Content-Type: application/json

{"provider":"wechat","credential":"<wx.login 返回的 code>"}
```

部署环境先设置一份服务级 `CREDENTIAL_ENCRYPTION_KEY`（至少 32 位并稳定备份），再进入管理后台的“项目总览 → 项目设置 → 微信 OpenID 登录”，为每个项目分别填写 AppID 与 AppSecret。AppSecret 使用 AES-256-GCM 加密存库，管理接口不会再次返回明文；服务端按 `X-Game-Id` 选择对应项目凭证调用微信 `code2Session`。微信返回的 `session_key` 不保存、不记录日志，也不会下发给小游戏。

取得 `user_token` 后，公开客户端可以直接读取所属项目的已发布配置：

```http
GET /api/client/me/configs?environment=production
Authorization: Bearer <user_token>
```

配置响应保留 `ETag`；客户端发送匹配的 `If-None-Match` 时返回 304。SDK 可注入兼容 `localStorage` 的 `configCache`，会自动持久化 ETag，并在 304 或临时断网时回退到最近一次成功配置。项目 ID 由签名 Token 确定，客户端不能借助请求头读取其他项目配置。完整微信接入步骤见 [`docs/wechat-login-and-player-config-integration.md`](docs/wechat-login-and-player-config-integration.md)。

未配置微信凭证时，可以继续设置 `PLATFORM_IDENTITY_WEBHOOK_URL` 作为其他平台或集中身份系统的 Adapter。系统会把 `gameKey`、`provider`、`credential` POST 到该可信服务，验证服务返回：

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

客户端可以先用 pako 压缩存档，既可以上传 pako 的二进制字符串，也可以转成 Base64。服务端不会解压或限制内部字段，会透明处理 JSONB 不支持的二进制字符，并在读取时原样返回：

```ts
const compressed = pako.deflate(JSON.stringify(saveData), { to: 'string' });
await client.saveCompressedArchive('default', compressed, currentVersion);
```

如果现有客户端通过 `uint8array_to_string(...)` 转换压缩结果，也可以直接把返回字符串作为 `data` 上传；Base64 仍更适合需要经过其他网关或日志系统的场景。

每个项目在“运营数据”页独立维护自己的事件名称、`event_key`、分类和说明。事件可以编辑、启停；尚无历史数据的定义可以删除。单次最多上报 100 条，服务器逐条处理并返回 `accepted`、`duplicated`、`rejected` 及每条结果；一条非法事件不会阻塞同批中的合法事件。`idempotency_key` 用于过滤网络重试产生的重复事件：

```ts
await client.trackEvent('level_start', { level: 12 });
await client.trackEvent('level_complete', { level: 12, stars: 3 });
```

### 通用属性分析

当项目需要分析等级、战力、章节、收藏数、修复度或其他自定义数据时，将打点的 `analysis_type` 设置为 `property`。服务器不内置任何业务字段；每个项目自行设置 JSON 字段路径、后台描述和类型。后台“新增打点 → 通过数据”支持粘贴单个定义、定义数组或带 `definitions` 数组的对象，也可以从带 `properties` 的上报样例推断多个字段。

```json
{
  "event_key": "player_snapshot",
  "name": "玩家状态快照",
  "category": "progress",
  "description": "关键进度发生变化时上报",
  "analysis_type": "property",
  "settings": {
    "fields": [
      { "key": "stats.power", "description": "玩家战力", "type": "number" },
      { "key": "chapter", "description": "当前章节", "type": "dimension", "limit": 30 },
      { "key": "source", "description": "进入来源", "type": "dimension", "limit": 20 }
    ]
  }
}
```

客户端仍然按普通事件上报，且可以携带定义之外的任意属性：

```ts
await client.trackEvent('player_snapshot', {
  stats: { power: 1260 },
  chapter: 'chapter_5',
  source: 'daily_login',
  any_other_project_data: { enabled: true },
});
```

- `number` 只统计 JSON 数字，按上报记录显示有效数据量、去重玩家、最小、最大、平均和合计。
- `dimension` 接受字符串、数字和布尔值，按值显示出现次数和去重玩家；`limit` 控制最多展示的高频值，范围为 1–100。
- 字段路径支持最多八层点号路径，例如 `player.stats.power`。
- 缺失字段、类型不匹配、对象或数组不会导致整条事件被拒绝；后台会显示被忽略的无效值数量。
- 统计周期跟随运营页顶部的 7/30/90 天选择，测试账号默认排除。

通用属性分析与 `level_result` 相互独立。普通项目、APP、小程序或网站如果不需要关卡语义，可以只使用 `count` 和 `property`。

打点定义可选择“关卡结果 / 疑似卡关分析”，并由每个项目自行添加 `mode_id`、后台显示名、允许的失败原因和疑似卡关阈值。关卡结果必须使用稳定玩家 Token，同时携带事件时间和幂等键：

```ts
await client.trackEvent('level_result', {
  schema_version: 1,
  mode_id: 'main',
  level_id: 'main-005',
  level_order: 5,
  result: 'fail',
  fail_reason: 'test_failure',
});
```

后台按玩法累计显示每关结果玩家、通关人数/次数、失败人数/次数、未通关失败、疑似卡关、玩家通关率、结果失败比例和人均失败次数，并展示最高玩到、最高通关和当前疑似卡关分布。关卡结果只按稳定玩家去重；顶部 7/30/90 天仅影响普通事件概览。

服务端也可向 `/api/client/events` 批量上报，此时 API Key 必须包含 `analytics:write`，且每条事件需提供 `user_id` 或 `session_id`。

## 管理接口

后台页面使用 `/api/admin/*`。登录后以 Bearer Token 调用，包含：项目类型与设置、测试账号及测试数据清理、运营打点定义/趋势/通用属性/卡关分析、多 API Key 与权限、配置 Schema/草稿/定时发布/事务批量发布/回滚、批量导入导出、游标分页玩家搜索、存档查看/编辑/删除/历史恢复、审计日志、指标和告警。全局 `admin` 可访问全部项目；项目成员只看到已加入的项目，其角色可以是 `viewer`、`editor` 或 `owner`。项目所有者可在概览中维护成员角色和测试账号，系统不允许移除最后一个所有者。删除项目必须显式传 `?confirm=DELETE`。

机器可读接口文档位于 `/openapi.json`，请求参数契约与核心响应结构已纳入 OpenAPI。TypeScript/Cocos SDK 位于 `/sdk/game-client.ts`；读取不存在的存档返回 `null`，并提供删除存档方法。端到端验收可在服务启动后运行 `npm run smoke`。

## 开发检查

提交前建议运行：

```bash
npm run check
```

该命令依次执行格式检查、TypeScript 与后台脚本检查、完整测试和生产构建。GitHub Actions 工作流也会在推送和 Pull Request 时执行同一命令。历史迁移目录不会被格式工具改写，迁移完整性由专门测试和运行时摘要校验负责。

## 上线前清单

- 将示例数据库/JWT/管理员密码全部替换，通过 HTTPS 暴露服务。
- API Key 不要放进可反编译的公开客户端；微信小游戏使用 `wx.login()` code 换取用户 Token，再访问 `/api/client/me/*`。
- API Key 当前没有有效期；应按环境拆分权限、定期手工轮换，并立即停用泄露或不再使用的 Key。
- 测试账号只用于开发和联调；正式发布前清空测试存档和打点并停用不再使用的账号，停用会立即使其 Token 失效。
- 每个项目的微信 AppSecret 只在项目设置中录入，不能写入小游戏代码、日志或仓库；`CREDENTIAL_ENCRYPTION_KEY` 必须独立备份，丢失后已有 AppSecret 无法解密。
- 后台域名必须使用 HTTPS 并加入对应微信小游戏的合法请求域名。
- 浏览器客户端需要在 `CLIENT_CORS_ORIGINS` 中配置精确来源；不要用反向代理直接放开任意 Origin。
- 为 PostgreSQL 设置自动备份与时间点恢复；配置数据库连接上限和告警。
- 根据流量在网关增加限流，服务可启动多个副本；热点配置再引入 Redis/CDN 缓存。
- 多副本部署将 `RATE_LIMIT_STORE` 设为 `database` 以共享限流计数；请求指标先在进程内短暂聚合，再批量写入数据库。
- 幂等记录和过期限流桶会自动清理；审计、原始事件、存档历史和已淘汰配置历史分别使用 `*_RETENTION_DAYS` 控制，值为 `0` 时永久保留。
- 如涉及付费或关键资产，存档写入必须增加服务端业务校验，不能直接信任客户端 JSON。

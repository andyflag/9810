# 部署与运维

## 运行方式

应用前后端同源。构建后 FastAPI 提供 `frontend/dist/index.html`、静态资源及 `/api/*` 接口，不需要单独部署前端。开发态 Vite 通过代理转发 API。API 文档在开发态的 `/api/docs`，生产态关闭。

当前数据库为 SQLite WAL，针对单机、小团队，使用一个应用进程。写事务使用 `BEGIN IMMEDIATE`，避免同时检查库存后发生超卖。记录版本用于防止旧页面覆盖新数据；FIFO 预览额外带企业全局版本。不要把 SQLite 文件放在 NFS / 多主共享卷上，也不要直接启动多个应用副本。

## 配置

| 配置 | 默认 | 作用 |
| --- | --- | --- |
| `APP_ENV` | development（Python / Compose） | production 开启 Secure Cookie，关闭交互 API 文档 |
| `DATA_DIR` | 项目根目录下 data | 数据库和附件 BLOB 所在持久目录；Compose 固定 /app/data |
| `BIND_HOST` | 127.0.0.1 | Compose 对外绑定的主机地址 |
| `PORT` | 8000 | Compose 主机端口 |

后端原生运行直接读取进程环境变量；不会自动读取 `.env`。Compose 会读取 `.env` 进行变量插值。

## HTTPS

使用已有反向代理将域名路由到 `127.0.0.1:8000`，启用 TLS，并将上传请求限制在 12 MB。正式使用设置 `APP_ENV=production`。Cookie 的 Secure 标记要求浏览器使用 HTTPS；HTTP 下不要启用 production 后期待保持登录。

推荐在反向代理配置速率限制、受控访问日志和定期备份。服务端已对注册 / 登录做持久化限速，不依赖客户端 IP 请求头。应用不接受跨站凭据 CORS，写请求必须带 `X-Requested-With: 9810`，因此浏览器跨站表单不能发起有效修改。部署时保持同源，不额外启用通配 CORS。

## 账号与团队

每个注册账号会获得一个空企业空间。管理员生成受邀邮箱绑定的链接（7 天有效）；同事用同一邮箱注册或登录后接受邀请，可从左上角切换企业。只读成员可以查看和导出。移除成员会立即撤销其对该企业的权限，保留其其他企业的访问和登录。敏感写入在同一写事务内再次校验会话与成员权限。

初版不发送邮件，也没有邮件验证或自助找回密码，不把电子邮箱验证作为企业授权依据。企业访问由已登录管理员的邀请链接和指定邮箱共同授予；邀请链接应通过可信渠道分享。对已有应用部署，建议在反向代理处限制注册入口的访问范围，按实际组织准入要求扩展账号体系。

没有固定管理员密码、后门账号或默认演示登录。所有密码用 scrypt + 随机盐保存，浏览器只持有随机会话 Cookie，数据库仅保存会话令牌哈希。会话有效期 7 天，退出后立即撤销。

## API 企业上下文

业务 API 使用 `X-Workspace-ID` 明确指定当前页面企业；附件和 Excel 下载链接使用 `workspace_id` 查询参数。二者同时出现时必须一致。除初次 `/api/state`、模板与身份级操作外，缺少企业标识的请求被拒绝。每次请求均验证该账号在指定企业的成员权限，不能以用户偏好或另一个标签页的企业选择代替本次操作的归属。

`/api/workspaces/switch` 与 `/api/invitations/accept` 返回 `tenant_id`；前端用该 ID 重新读取数据。每个浏览器标签页单独保存企业选择。旧脚本客户端须同步添加企业请求头；升级后已打开的旧页面请刷新。

请求体按实际字节流限制为 12 MB，不依赖 `Content-Length`。无效 JSON 和超限上传在进入业务写入前拒绝。

## 备份与还原

SQLite 在线运行时应使用数据库的 backup API。它同时备份用户、企业、台账、日志、会话和附件 BLOB；不要在运行中仅复制主文件并遗漏 WAL。

原生部署示例：

```bash
python - <<'PY'
import sqlite3
from pathlib import Path
from datetime import datetime
source = sqlite3.connect('data/9810.sqlite3')
backup_dir = Path('backups')
backup_dir.mkdir(exist_ok=True)
backup_path = backup_dir / ('9810-' + datetime.now().strftime('%Y%m%d-%H%M%S') + '.sqlite3')
target = sqlite3.connect(backup_path)
source.backup(target)
target.close()
source.close()
print(backup_path)
PY
```

备份包含企业数据和登录凭据哈希，应置于访问受限的存储。定期验证备份可读取。

还原前停止应用，将验证过的备份替换数据目录里的 `9810.sqlite3`，移走原 `9810.sqlite3-wal`、`9810.sqlite3-shm`，确保目录可写，再启动。还原会回到备份时刻，不能保留之后的修改。迁移到新主机前，应先保留原卷快照。

数据库当前结构版本为 `PRAGMA user_version = 1`，首次启动执行幂等初始化。后续结构变更应新增显式迁移，避免覆盖既有数据。

## 容量与扩展

单个附件不超过 10 MB、每企业附件总量不超过 100 MB。工作台目前读取当前企业完整台账，页面按 10 条分页；适合模板规模及小团队。更大数据量应改为数据库聚合与服务端分页，并将附件迁移至对象存储。多实例部署应迁移至 PostgreSQL，同时保留租户过滤、事务库存校验、记录版本和权限测试。

Dockerfile / Compose 已提供，尚未在本次环境中实测 Docker 镜像构建；原生构建、API 和 Chromium 验证详见验收记录。

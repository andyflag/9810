# 9810 · Sites 托管版

原 Excel 台账的云端应用。React 前端、Cloudflare Worker API、D1 数据库与 R2 附件存储；使用 Sites 提供的 ChatGPT 登录身份。原 Python 自托管版位于 [andyflag/9810](https://github.com/andyflag/9810)。

## 功能

- SKU 档案、出口报关、收汇、销售、退税、异常和单证台账，以及核销总表。
- 原模板 Excel 导入预览、去重、整批校验和导出；FIFO 销量分配。
- 使用十进制定点规则计算金额；按实际入账分配收汇，预退税申报共享已售数量，币种分别汇总。
- 每个新用户拥有独立企业空间；管理员通过邮箱绑定的邀请链接添加编辑或只读成员。
- 附件、操作日志、库存校验和并发版本锁。示例数据仅在用户点击“体验示例数据”后载入。

站点首次发布保持私有。需要团队协作时，先在 Sites 共享设置中允许同事访问，再使用应用内“团队成员”邀请加入企业。应用不会自动更改 Sites 访问权限。邀请链接由管理员自行发送。

## 本地验证

要求 Node.js 22 或更新版本。

```bash
npm ci
npm ci --prefix frontend
npm run check
npm test
npm run build
npx wrangler d1 migrations apply DB --local --config wrangler.jsonc
npm run dev
```

另一终端运行 `npm run test:integration`，验证 D1/R2 上的身份、租户隔离、附件、邀请撤销、乐观锁、Excel 往返和 FIFO 分配。该测试只访问 `127.0.0.1:8787`，通过请求头模拟 Sites 在可信边界内注入的身份，生产代码没有测试登录入口。

`tests/fixtures/python-parity.json` 是原 Python 核算引擎产生的 10 组参考快照，覆盖原表格、部分及超额分摊收汇、金额舍入、多笔预退税、币种隔离和截止日边界。

## 发布

`.openai/hosting.json` 保存现有 Sites 项目 ID 和逻辑存储绑定；不要另建同名站点。`wrangler.jsonc` 只用于本机模拟，不包含生产资源 ID。

构建产生单一 ESM Worker（含前端静态资源）、托管清单和 `drizzle/` 迁移。将同一源代码提交推送到 Sites 源仓库，再从该提交运行 `npm run package`，通过 Sites 保存版本并私有发布。归档 `outputs/site.tar.gz` 保留 `.openai/hosting.json`、`dist/server/` 和 `drizzle/` 的完整路径；不能把 `dist/` 直接作为归档根目录。凭证仅通过临时进程环境传入 Git，不写入源代码、Git 配置或构建产物。

数据库结构由 `db/schema.ts` 管理，使用 `npm run db:generate` 生成后续增量迁移。不要修改已上线的迁移文件。企业记录在 D1 中以带版本号的快照保存；每次修改使用比较并交换与同事务审计，避免并发覆盖。附件内容保存在 R2，元数据与归属保存在 D1。

## 当前容量与边界

- 每个企业最多 1.5 MB 台账及附件元数据文本，单个 Excel 或附件最多 10 MB，企业附件总容量 100 MB。超限时明确拒绝写入。
- Excel 导出是当前核算结果快照；重新导入会重算自动字段。企业参数在应用设置中维护，不自动用导入文件覆盖。
- 文件备份请分别导出台账、下载单证。应用未集成 Amazon、银行或税务系统自动对接，也未实现定时备份与付费订阅。
- Sites 与 Python 版使用各自的数据存储，不会自动同步企业数据。

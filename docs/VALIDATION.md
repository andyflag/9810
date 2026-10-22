# 初版验收记录

本页保留初版实现时的验证结果。后续 Sites 发布和全面审查后的最新结果见 [2026-10-22 审查报告](REVIEW-2026-10-22.md)；当前权限协议和部署方式见 [部署说明](DEPLOYMENT.md)。

验证日期：2026-10-22。

## 自动化

- `python -m pytest -q`：**18 项通过**。测试使用独立临时数据库，不涉及生产记录。
- `npm run build --prefix frontend`：TypeScript 检查与 Vite 生产构建通过。
- `npm audit --omit=dev --audit-level=high`：运行时依赖报告 0 个已知漏洞。

业务样本与原表一致：报关 1,500 件、签收 1,496 件、净售出 885 件、异常减少 3 件、剩余 608 件、预退税 7,540 元；USD 净回款 17,391、已收汇 10,195、待收汇 7,196。

自动化涵盖部分收汇、过量分摊不虚增到账、Decimal 舍入、核算临界日、生产企业计税、多个预退税记录共享销量、币种隔离、0 签收数量、反向日期、Excel 往返与公式注入、重复导入与原子回滚、跨企业读写隔离、只读权限、一次性邀请、成员移除与会话失效、乐观并发锁、FIFO 跨批次分配、附件持久化和重启。

## 浏览器

Chromium 实际访问生产构建和 FastAPI 后端。桌面 1512 × 1100、手机 390 × 844：

- 注册新企业 → 初始空态 → 主动载入模板示例。
- 新增报关记录并自动生成核销编号。
- SKU 新增、修改、删除。
- 搜索无结果和清空筛选。
- 下载有效的 Excel 导出文件。
- 移动端导航、横向表格滚动；页面无整体横向溢出。
- 单证附件上传，保存成功后出现在授权下载列表。
- 页面刷新后会话与业务记录仍保留。
- 未发现 JavaScript 页面运行错误。

截图：[桌面工作台](screenshots/dashboard.png)、[移动端](screenshots/mobile.png)。截图中均为模板示例企业数据。

可重复运行浏览器验证（自行启动临时服务和数据库，不连接线上系统）：

```bash
pip install -r requirements-browser.txt
python -m playwright install chromium
npm run build --prefix frontend
python tests/browser_smoke.py
```

如果已有 Chromium，可设置 `BROWSER_EXECUTABLE=/path/to/chromium`。截图默认输出到被 Git 忽略的 `test-results/browser/`。

## 验证边界

- 未执行公网域名与 HTTPS 部署；本次未配置云服务器、生产数据库或第三方商业系统。
- 提供 Dockerfile 与 Compose，但未实际构建 / 运行 Docker 容器。
- 测试没有覆盖大规模数据压测、法规有效性核验、计费、邮件投递或第三方接口，这些也不是本次实现范围。
- 测试库产生一条 Starlette 关于 httpx 测试客户端未来迁移的弃用提示，不影响当前测试通过。

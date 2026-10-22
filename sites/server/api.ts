import {
  SCHEMA,
  ORDER,
  clean,
  cleanSettings,
  compute,
  validateState,
  D,
  money,
  allocateMoney,
  RuleError,
  type Row,
} from './domain';
import {
  context,
  requireOwner,
  requireWrite,
  save,
  record,
  version,
  audit,
  auditStatement,
  hash,
  uuid,
  now,
  HttpError,
  type Env,
  type Context,
} from './storage';
import { parseWorkbook, mergeRecords, exportWorkbook } from './excel';
import sample from './sample.json';
const json = (data: any, status = 200) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
async function body(request: Request) {
  try {
    const value = await request.json();
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new RuleError('请求数据必须为 JSON 对象');
    return value as Row;
  } catch {
    throw new RuleError('请求数据格式不正确');
  }
}
async function formData(request: Request) {
  try {
    return await request.formData();
  } catch {
    throw new RuleError('上传请求格式不正确');
  }
}
function email(value: any) {
  const s = String(value || '')
    .trim()
    .toLowerCase();
  if (!/^[^\s@]{1,100}@[^\s@]{1,100}\.[^\s@]{2,30}$/.test(s)) throw new RuleError('请输入有效邮箱');
  return s;
}
const cleanId = (value: unknown) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,150}$/.test(value))
    throw new RuleError('企业标识格式不正确');
  return value;
};
export async function api(request: Request, env: Env, template: () => Response): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method;
  if (path === '/api/health') {
    if (!env.DB || !env.BUCKET) throw new HttpError(503, '云端存储正在初始化');
    const tables = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('workspaces','memberships','preferences','audit','invitations')",
    ).first<{ count: number }>();
    if (tables?.count !== 5) throw new HttpError(503, '云端数据库正在初始化');
    return json({ status: 'ok', version: '1.0.0-sites', storage: 'ready' });
  }
  const identityOperation =
    method === 'POST' && ['/api/workspaces/switch', '/api/invitations/accept'].includes(path);
  const ctx = await context(request, env, {
      allowDefault: identityOperation || ['/api/state', '/api/template'].includes(path),
      ignoreWorkspace: identityOperation,
    }),
    db = env.DB,
    id = ctx.workspace.id;
  if (path === '/api/state' && method === 'GET') {
    const workspaces = (
      await db
        .prepare(
          'SELECT w.id,w.name,m.role FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? ORDER BY w.id',
        )
        .bind(ctx.user.id)
        .all()
    ).results;
    return json({
      ...compute(ctx.records, ctx.settings),
      schema: SCHEMA,
      settings: ctx.settings,
      revision: ctx.workspace.revision,
      user: { ...ctx.user, role: ctx.role, tenant_id: id },
      workspaces,
      files: ctx.files.map(({ key, mime, ...rest }) => rest),
      hosting: 'sites',
    });
  }
  if (path === '/api/template' && method === 'GET') return template();
  if (path === '/api/export' && method === 'GET') {
    const bytes = exportWorkbook(ctx.records, ctx.settings);
    await audit(ctx, '导出台账', 'workbook');
    return new Response(bytes, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition':
          "attachment; filename*=UTF-8''" +
          encodeURIComponent('9810核销台账-' + new Date().toISOString().slice(0, 10) + '.xlsx'),
      },
    });
  }
  if (path === '/api/workspaces/switch' && method === 'POST') {
    const b = await body(request),
      tenantId = cleanId(b.tenant_id);
    const membership = await db
      .prepare('SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=?')
      .bind(tenantId, ctx.user.id)
      .first();
    if (!membership) throw new HttpError(403, '无权访问该企业');
    const changed = await db
      .prepare(
        'UPDATE preferences SET workspace_id=? WHERE user_id=? AND EXISTS(SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=?)',
      )
      .bind(tenantId, ctx.user.id, tenantId, ctx.user.id)
      .run();
    if (!changed.meta.changes) throw new HttpError(403, '企业访问权限已被撤销');
    return json({ ok: true, tenant_id: tenantId });
  }
  if (path === '/api/team' && method === 'GET') {
    requireOwner(ctx);
    return json(
      (
        await db
          .prepare(
            'SELECT user_id AS id,email,name,role FROM memberships WHERE workspace_id=? ORDER BY role,name',
          )
          .bind(id)
          .all()
      ).results,
    );
  }
  if (path === '/api/invitations' && method === 'POST') {
    requireOwner(ctx);
    const b = await body(request),
      address = email(b.email),
      role = b.role || 'editor';
    if (!['editor', 'viewer'].includes(role)) throw new RuleError('邀请角色必须为编辑或只读');
    const existing = await db
      .prepare('SELECT 1 FROM memberships WHERE workspace_id=? AND email=?')
      .bind(id, address)
      .first();
    if (existing) throw new HttpError(409, '该成员已在企业中，无需重复邀请');
    const token = uuid() + uuid(),
      mutation = uuid();
    const results = await db.batch([
      db
        .prepare(
          "UPDATE workspaces SET revision=revision+1,mutation_id=? WHERE id=? AND EXISTS(SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=? AND role='owner') AND NOT EXISTS(SELECT 1 FROM memberships WHERE workspace_id=? AND email=?)",
        )
        .bind(mutation, id, id, ctx.user.id, id, address),
      db
        .prepare(
          'DELETE FROM invitations WHERE workspace_id=? AND email=? AND used_at IS NULL AND EXISTS(SELECT 1 FROM workspaces WHERE id=? AND mutation_id=?)',
        )
        .bind(id, address, id, mutation),
      db
        .prepare(
          'INSERT INTO invitations(token_hash,workspace_id,email,role,expires_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM workspaces WHERE id=? AND mutation_id=?)',
        )
        .bind(await hash(token), id, address, role, Date.now() + 7 * 86400000, id, mutation),
      auditStatement(ctx, '邀请成员', address, null, { role }, mutation),
    ]);
    if (!results[0].meta.changes) throw new HttpError(409, '成员或权限已变化，请刷新后重试');
    return json({ token, expires_days: 7 });
  }
  if (path === '/api/invitations/accept' && method === 'POST') {
    const b = await body(request),
      token = await hash(String(b.token || '').slice(0, 200));
    const invitation = await db
      .prepare('SELECT * FROM invitations WHERE token_hash=? AND used_at IS NULL AND expires_at>?')
      .bind(token, Date.now())
      .first<Row>();
    if (!invitation) throw new RuleError('邀请已过期或已使用');
    if (invitation.email !== ctx.user.email)
      throw new HttpError(403, '请使用受邀邮箱对应的 ChatGPT 账号登录');
    const mutation = uuid(),
      joinedContext = { ...ctx, workspace: { ...ctx.workspace, id: invitation.workspace_id } };
    const results = await db.batch([
      db
        .prepare(
          'UPDATE invitations SET used_at=?,claim_id=? WHERE token_hash=? AND used_at IS NULL AND expires_at>? AND email=?',
        )
        .bind(now(), mutation, token, Date.now(), ctx.user.email),
      db
        .prepare(
          'INSERT INTO memberships(id,workspace_id,user_id,email,name,role) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM invitations WHERE token_hash=? AND claim_id=?) ON CONFLICT DO NOTHING',
        )
        .bind(
          invitation.workspace_id + ':' + ctx.user.id,
          invitation.workspace_id,
          ctx.user.id,
          ctx.user.email,
          ctx.user.name,
          invitation.role,
          token,
          mutation,
        ),
      db
        .prepare(
          'UPDATE preferences SET workspace_id=? WHERE user_id=? AND EXISTS(SELECT 1 FROM invitations WHERE token_hash=? AND claim_id=?) AND EXISTS(SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=?)',
        )
        .bind(
          invitation.workspace_id,
          ctx.user.id,
          token,
          mutation,
          invitation.workspace_id,
          ctx.user.id,
        ),
      db
        .prepare(
          'UPDATE workspaces SET revision=revision+1,mutation_id=? WHERE id=? AND EXISTS(SELECT 1 FROM invitations WHERE token_hash=? AND claim_id=?)',
        )
        .bind(mutation, invitation.workspace_id, token, mutation),
      auditStatement(joinedContext, '加入企业', ctx.user.email, null, null, mutation),
    ]);
    if (!results[0].meta.changes) throw new RuleError('邀请已过期、已使用或已被撤销');
    return json({ ok: true, tenant_id: invitation.workspace_id });
  }
  if (path.startsWith('/api/team/') && method === 'DELETE') {
    requireOwner(ctx);
    let userId: string;
    try {
      userId = decodeURIComponent(path.slice('/api/team/'.length));
    } catch {
      throw new RuleError('成员标识格式不正确');
    }
    const member = await db
      .prepare('SELECT * FROM memberships WHERE workspace_id=? AND user_id=?')
      .bind(id, userId)
      .first<Row>();
    if (!member) throw new HttpError(404, '成员不存在');
    if (member.role === 'owner') throw new HttpError(409, '不能移除管理员');
    const mutation = uuid();
    const results = await db.batch([
      db
        .prepare(
          "UPDATE workspaces SET revision=revision+1,mutation_id=? WHERE id=? AND EXISTS(SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=? AND role='owner') AND EXISTS(SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=? AND role!='owner')",
        )
        .bind(mutation, id, id, ctx.user.id, id, userId),
      db
        .prepare(
          'DELETE FROM invitations WHERE workspace_id=? AND email=? AND used_at IS NULL AND EXISTS(SELECT 1 FROM workspaces WHERE id=? AND mutation_id=?)',
        )
        .bind(id, member.email, id, mutation),
      db
        .prepare(
          "DELETE FROM memberships WHERE workspace_id=? AND user_id=? AND role!='owner' AND EXISTS(SELECT 1 FROM workspaces WHERE id=? AND mutation_id=?)",
        )
        .bind(id, userId, id, mutation),
      auditStatement(ctx, '移除成员', userId, null, null, mutation),
    ]);
    if (!results[0].meta.changes) throw new HttpError(409, '成员或权限已变化，请刷新后重试');
    return json({ ok: true });
  }
  if (path === '/api/audit' && method === 'GET') {
    requireOwner(ctx);
    return json(
      (
        await db
          .prepare(
            'SELECT id,name,action,target,before_json,after_json,created_at FROM audit WHERE workspace_id=? ORDER BY created_at DESC,id DESC LIMIT 200',
          )
          .bind(id)
          .all()
      ).results,
    );
  }
  if (path === '/api/settings' && method === 'PUT') {
    requireOwner(ctx);
    const b = await body(request);
    if (b.version !== ctx.workspace.revision)
      throw new HttpError(409, '数据已更新，请刷新后重新保存参数');
    if (!b.data || typeof b.data !== 'object' || Array.isArray(b.data))
      throw new RuleError('企业参数必须为 JSON 对象');
    const settings = cleanSettings(b.data);
    await save(
      ctx,
      ctx.records,
      '修改企业参数',
      'settings',
      ctx.settings,
      settings,
      settings,
      ctx.files,
      true,
    );
    return json({ ok: true });
  }
  if (path === '/api/demo' && method === 'POST') {
    requireWrite(ctx);
    if (ORDER.some((k) => ctx.records[k].length))
      throw new HttpError(409, '只能在空企业中载入示例，现有数据不会被覆盖');
    const records = Object.fromEntries(
      ORDER.map((k) => [
        k,
        (sample as Row)[k].map((r: Row) => ({ ...clean(k, r), id: uuid(), version: 1 })),
      ]),
    );
    await save(
      ctx,
      records,
      '载入模板示例',
      'demo',
      null,
      Object.fromEntries(ORDER.map((k) => [k, records[k].length])),
    );
    return json({ ok: true });
  }
  if (path === '/api/import' && method === 'POST') {
    requireWrite(ctx);
    const form = await formData(request),
      file = form.get('file');
    if (!(file instanceof File)) throw new RuleError('请选择 Excel 文件');
    if (file.size > 10 * 1024 * 1024) throw new RuleError('Excel 文件不得超过 10 MB');
    const incoming = parseWorkbook(new Uint8Array(await file.arrayBuffer()));
    const { combined, added, counts, skipped } = mergeRecords(ctx.records, incoming);
    validateState(combined, ctx.settings);
    const dry = url.searchParams.get('dry_run') !== 'false';
    if (!dry && added.length)
      await save(ctx, combined, '导入 Excel', 'workbook', null, { counts, skipped });
    return json({
      counts,
      total: added.length,
      skipped,
      examples: added.filter(([, r]) => String(r.notes || '').includes('示例')).length,
      committed: !dry,
      workbook_settings: {},
    });
  }
  if (path === '/api/sales/fifo' && method === 'POST') {
    requireWrite(ctx);
    const b = await body(request);
    if (!Number.isInteger(b.quantity) || b.quantity <= 0 || b.quantity > 1000000000)
      throw new RuleError('售出数量须为正整数');
    if (b.commit !== undefined && typeof b.commit !== 'boolean')
      throw new RuleError('是否提交必须为布尔值');
    for (const field of ['gross', 'fees']) {
      try {
        if (!['number', 'string'].includes(typeof b[field]) || b[field] === '') throw Error();
        const amount = D(b[field]);
        if (!amount.isFinite() || amount.abs().gt('1000000000000') || amount.decimalPlaces() > 8)
          throw Error();
      } catch {
        throw new RuleError('销售金额和费用必须填写有效数字');
      }
    }
    if (b.commit && b.revision !== ctx.workspace.revision)
      throw new HttpError(409, '台账已变化，请重新预览 FIFO 分配');
    const receipt = ctx.records.receipts.find((r) => r.settlement_id === b.settlement_id);
    if (!receipt) throw new RuleError('使用 FIFO 前请先登记对应结算报告');
    const lots = compute(ctx.records, ctx.settings)
      .ledger.filter(
        (r) =>
          r.sku === b.sku &&
          r.currency === receipt.currency &&
          (!receipt.site || r.site === receipt.site) &&
          r.remaining > 0,
      )
      .sort(
        (a, b) =>
          a.export_date.localeCompare(b.export_date) || a.ledger_id.localeCompare(b.ledger_id),
      );
    let remaining = b.quantity;
    let rows: Row[] = [];
    for (const lot of lots) {
      const quantity = Math.min(remaining, lot.remaining);
      if (!quantity) break;
      let gross: number, fees: number;
      try {
        gross = money(D(b.gross).mul(quantity).div(b.quantity));
        fees = money(D(b.fees).mul(quantity).div(b.quantity));
      } catch {
        throw new RuleError('销售金额或费用格式不正确');
      }
      rows.push({
        month: b.month,
        settlement_id: b.settlement_id,
        sku: b.sku,
        ledger_id: lot.ledger_id,
        sold_qty: quantity,
        returned_qty: 0,
        gross,
        fees,
        site: lot.site,
        sale_date: b.sale_date,
        evidence_date: b.evidence_date,
        notes: 'FIFO 自动分配',
      });
      remaining -= quantity;
    }
    if (remaining)
      throw new RuleError(`可用库存不足，还差 ${remaining} 件；请核对 SKU、站点和币种`);
    for (const field of ['gross', 'fees']) {
      const allocated = allocateMoney(
        b[field],
        rows.map((row) => row.sold_qty),
      );
      rows.forEach((row, index) => {
        row[field] = allocated[index];
      });
    }
    rows = rows.map((r) => clean('sales', r));
    const records = structuredClone(ctx.records);
    records.sales.push(...rows.map((r) => ({ ...r, id: uuid(), version: 1 })));
    validateState(records, ctx.settings);
    if (b.commit) await save(ctx, records, 'FIFO 销量分配', String(b.sku), null, { records: rows });
    return json({ rows, revision: ctx.workspace.revision, committed: !!b.commit });
  }
  const recordsMatch = path.match(/^\/api\/records\/([^/]+)(?:\/([^/]+))?$/);
  if (recordsMatch) {
    requireWrite(ctx);
    const [, kind, recordId] = recordsMatch;
    if (!Object.hasOwn(SCHEMA, kind)) throw new HttpError(404, '台账不存在');
    const records = structuredClone(ctx.records);
    if (method === 'POST' && !recordId) {
      const b = await body(request),
        data = clean(kind, b.data),
        row = { ...data, id: uuid(), version: 1 };
      records[kind].push(row);
      await save(ctx, records, '新增记录', kind + ':' + row.id, null, data);
      return json({ id: row.id });
    }
    if (method === 'PUT' && recordId) {
      const b = await body(request),
        old = record(ctx, kind, recordId);
      version(old, b.version);
      const data = clean(kind, b.data);
      records[kind] = records[kind].map((r) =>
        r.id === recordId ? { ...data, id: recordId, version: old.version + 1 } : r,
      );
      await save(ctx, records, '更新记录', kind + ':' + recordId, clean(kind, old), data);
      return json({ ok: true });
    }
    if (method === 'DELETE' && recordId) {
      const old = record(ctx, kind, recordId);
      version(old, Number(url.searchParams.get('version')));
      records[kind] = records[kind].filter((r) => r.id !== recordId);
      const removed = ctx.files.filter((r) => r.record_id === recordId),
        files = ctx.files.filter((r) => r.record_id !== recordId);
      await save(
        ctx,
        records,
        '删除记录',
        kind + ':' + recordId,
        clean(kind, old),
        null,
        ctx.settings,
        files,
      );
      if (removed.length) await env.BUCKET.delete(removed.map((r) => r.key));
      return json({ ok: true });
    }
  }
  const upload = path.match(/^\/api\/documents\/([^/]+)\/files$/);
  if (upload && method === 'POST') {
    requireWrite(ctx);
    const doc = record(ctx, 'documents', upload[1]),
      form = await formData(request),
      file = form.get('file');
    if (!(file instanceof File) || !file.size || file.size > 10 * 1024 * 1024)
      throw new RuleError('附件需为 1 字节至 10 MB');
    const name = file.name.replaceAll('\\', '/').split('/').at(-1)!.slice(0, 200);
    const allowed: Row = {
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      txt: 'text/plain',
      csv: 'text/csv',
    };
    const extension = name.split('.').at(-1)!.toLowerCase();
    const mime = Object.hasOwn(allowed, extension) ? allowed[extension] : undefined;
    if (!mime) throw new RuleError('支持 PDF、PNG、JPG、XLSX、DOCX、TXT 和 CSV 附件');
    if (ctx.files.reduce((a, r) => a + r.size, 0) + file.size > 100 * 1024 * 1024)
      throw new RuleError('当前企业附件总容量上限为 100 MB');
    const fileId = uuid(),
      key = `${id}/${doc.id}/${fileId}`;
    await env.BUCKET.put(key, file.stream(), { httpMetadata: { contentType: mime } });
    const entry = {
      id: fileId,
      record_id: doc.id,
      name,
      mime,
      size: file.size,
      key,
      created_at: now(),
    };
    try {
      await save(
        ctx,
        ctx.records,
        '上传单证',
        doc.id,
        null,
        { id: fileId, name, size: file.size },
        ctx.settings,
        [...ctx.files, entry],
      );
    } catch (e) {
      await env.BUCKET.delete(key);
      throw e;
    }
    return json({ id: fileId });
  }
  const fileMatch = path.match(/^\/api\/files\/([^/]+)$/);
  if (fileMatch) {
    const file = ctx.files.find((f) => f.id === fileMatch[1]);
    if (!file) throw new HttpError(404, '附件不存在');
    if (method === 'GET') {
      const object = await env.BUCKET.get(file.key);
      if (!object) throw new HttpError(404, '附件不存在');
      return new Response(object.body, {
        headers: {
          'Content-Type': file.mime,
          'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.name),
          'Cache-Control': 'no-store',
        },
      });
    }
    if (method === 'DELETE') {
      requireWrite(ctx);
      await save(
        ctx,
        ctx.records,
        '删除单证',
        file.record_id,
        { id: file.id, name: file.name },
        null,
        ctx.settings,
        ctx.files.filter((f) => f.id !== file.id),
      );
      await env.BUCKET.delete(file.key);
      return json({ ok: true });
    }
  }
  throw new HttpError(404, '接口不存在');
}

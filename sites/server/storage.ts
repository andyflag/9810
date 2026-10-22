import { DEFAULT_SETTINGS, emptyData, validateState, RuleError, type Row } from './domain';
export type Env = { DB: D1Database; BUCKET: R2Bucket };
export type Identity = { id: string; email: string; name: string };
export type Context = {
  env: Env;
  user: Identity;
  workspace: Row;
  settings: Row;
  records: Record<string, Row[]>;
  files: Row[];
  role: string;
};
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
export const uuid = () => crypto.randomUUID();
export async function hash(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
export function identity(request: Request): Identity {
  const id = request.headers.get('oai-authenticated-user-id'),
    email = request.headers.get('oai-authenticated-user-email');
  if (!id || !email) throw new HttpError(401, '请使用 ChatGPT 登录');
  let name = request.headers.get('oai-authenticated-user-full-name') || email.split('@')[0];
  if (request.headers.get('oai-authenticated-user-full-name-encoding') === 'percent-encoded-utf-8')
    try {
      name = decodeURIComponent(name);
    } catch {}
  return { id, email: email.toLowerCase(), name };
}
export async function context(request: Request, env: Env): Promise<Context> {
  const user = identity(request);
  if (!env.DB || !env.BUCKET) throw new HttpError(503, '云端存储正在初始化，请稍后重试');
  const id = 'w_' + (await hash(user.id)).slice(0, 32),
    db = env.DB;
  const pref = await db
    .prepare('SELECT workspace_id FROM preferences WHERE user_id=?')
    .bind(user.id)
    .first<Row>();
  if (!pref) {
    await db.batch([
      db
        .prepare(
          'INSERT INTO workspaces(id,name,settings,data,revision,updated_at) VALUES(?,?,?,?,0,?) ON CONFLICT DO NOTHING',
        )
        .bind(
          id,
          '我的企业',
          JSON.stringify(DEFAULT_SETTINGS),
          JSON.stringify({ records: emptyData(), files: [] }),
          now(),
        ),
      db
        .prepare(
          'INSERT INTO memberships(id,workspace_id,user_id,email,name,role) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',
        )
        .bind(id + ':' + user.id, id, user.id, user.email, user.name, 'owner'),
      db
        .prepare('INSERT INTO preferences(user_id,workspace_id) VALUES(?,?) ON CONFLICT DO NOTHING')
        .bind(user.id, id),
    ]);
  }
  const active = pref?.workspace_id || id;
  const row = await db
    .prepare(
      'SELECT w.*,m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE w.id=? AND m.user_id=?',
    )
    .bind(active, user.id)
    .first<Row>();
  if (!row) {
    await db
      .prepare('UPDATE preferences SET workspace_id=? WHERE user_id=?')
      .bind(id, user.id)
      .run();
    const own = await db
      .prepare(
        'SELECT w.*,m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE w.id=? AND m.user_id=?',
      )
      .bind(id, user.id)
      .first<Row>();
    if (!own) throw new HttpError(403, '企业访问权限已被撤销');
    const d = JSON.parse(own.data);
    return {
      env,
      user,
      workspace: own,
      settings: JSON.parse(own.settings),
      records: d.records,
      files: d.files || [],
      role: own.role,
    };
  }
  const data = JSON.parse(row.data);
  return {
    env,
    user,
    workspace: row,
    settings: JSON.parse(row.settings),
    records: data.records,
    files: data.files || [],
    role: row.role,
  };
}
export function requireWrite(ctx: Context) {
  if (ctx.role === 'viewer') throw new HttpError(403, '只读成员不能修改数据');
}
export function requireOwner(ctx: Context) {
  if (ctx.role !== 'owner') throw new HttpError(403, '只有管理员可以执行此操作');
}
export async function audit(
  ctx: Context,
  action: string,
  target: string,
  before: any = null,
  after: any = null,
) {
  await ctx.env.DB.prepare(
    'INSERT INTO audit(id,workspace_id,user_id,name,action,target,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
  )
    .bind(
      uuid(),
      ctx.workspace.id,
      ctx.user.id,
      ctx.user.name,
      action,
      target,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      now(),
    )
    .run();
}
export async function save(
  ctx: Context,
  records: Record<string, Row[]>,
  action: string,
  target: string,
  before: any = null,
  after: any = null,
  settings = ctx.settings,
  files = ctx.files,
) {
  requireWrite(ctx);
  validateState(records, settings);
  const data = JSON.stringify({ records, files });
  if (new TextEncoder().encode(data).length > 1500000)
    throw new RuleError(
      '当前企业台账达到云端初版容量上限（1.5 MB 文本记录），请先导出归档或联系管理员扩容',
    );
  const mutation = uuid(),
    db = ctx.env.DB;
  const results = await db.batch([
    db
      .prepare(
        "UPDATE workspaces SET data=?,settings=?,name=?,revision=revision+1,mutation_id=?,updated_at=? WHERE id=? AND revision=? AND EXISTS(SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=? AND role IN ('owner','editor'))",
      )
      .bind(
        data,
        JSON.stringify(settings),
        settings.company_name,
        mutation,
        now(),
        ctx.workspace.id,
        ctx.workspace.revision,
        ctx.workspace.id,
        ctx.user.id,
      ),
    db
      .prepare(
        'INSERT INTO audit(id,workspace_id,user_id,name,action,target,before_json,after_json,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM workspaces WHERE id=? AND mutation_id=?)',
      )
      .bind(
        uuid(),
        ctx.workspace.id,
        ctx.user.id,
        ctx.user.name,
        action,
        target,
        before === null ? null : JSON.stringify(before),
        after === null ? null : JSON.stringify(after),
        now(),
        ctx.workspace.id,
        mutation,
      ),
  ]);
  if (!results[0].meta.changes)
    throw new HttpError(409, '数据已被其他成员修改或权限发生变化，请刷新后重试');
}
export function record(ctx: Context, kind: string, id: string) {
  const row = ctx.records[kind]?.find((r) => r.id === id);
  if (!row) throw new HttpError(404, '记录不存在');
  return row;
}
export function version(row: Row, value: any) {
  if (row.version !== value) throw new HttpError(409, '记录已被其他成员修改，请刷新后重新编辑');
}

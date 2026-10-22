import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { api } from '../server/api';
import { context, hash, identity, save, type Env } from '../server/storage';
import { boundedRequest, MAX_REQUEST_BYTES } from '../server/request';

let runtime: Miniflare;
let env: Env;
before(async () => {
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'security-tests',
          modules: true,
          script: 'export default { fetch() { return new Response("test"); } };',
          compatibilityDate: '2026-05-15',
          d1Databases: { DB: 'security-tests' },
        },
      ],
    }),
  );
  const database = await runtime.getD1Database('DB', 'security-tests');
  env = { DB: database as unknown as D1Database, BUCKET: {} as R2Bucket };
  for (const file of readdirSync('drizzle')
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    for (const sql of readFileSync('drizzle/' + file, 'utf8').split('--> statement-breakpoint')) {
      if (sql.trim()) await env.DB.prepare(sql).run();
    }
  }
});
after(async () => {
  await runtime?.dispose();
});

function request(user: string, path: string, scope?: string, method = 'GET', payload?: unknown) {
  const headers: Record<string, string> = {
    'oai-authenticated-user-id': user,
    'oai-authenticated-user-email': user + '@example.com',
    'X-Requested-With': '9810',
    'Content-Type': 'application/json',
  };
  if (scope) headers['X-Workspace-ID'] = scope;
  return new Request('http://local.test' + path, {
    headers,
    method,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}
async function invoke(
  user: string,
  path: string,
  scope?: string,
  method = 'GET',
  payload?: unknown,
  selected = env,
) {
  try {
    return await api(
      request(user, path, scope, method, payload),
      selected,
      () => new Response('template'),
    );
  } catch (error) {
    const e = error as Error & { status?: number };
    return Response.json({ detail: e.message }, { status: e.status || 500 });
  }
}
async function bootstrap(user: string) {
  const result = await invoke(user, '/api/state');
  assert.equal(result.status, 200);
  return (await result.json()) as any;
}
const sku = { sku: 'PRIVATE-A', name: 'Only for company A', unit: '件', tax_rate: '0.13' };

test('Hosted identity requires a stable ID and email; encoded names are display-only', () => {
  const incompleteHeaders: Record<string, string>[] = [
    {},
    { 'oai-authenticated-user-email': 'person@example.com' },
    { 'oai-authenticated-user-id': 'stable-site-user' },
  ];
  for (const headers of incompleteHeaders) {
    assert.throws(
      () => identity(new Request('http://local.test/api/state', { headers })),
      (error: any) => error.status === 401,
    );
  }
  assert.deepEqual(
    identity(
      new Request('http://local.test/api/state', {
        headers: {
          'oai-authenticated-user-id': 'stable-site-user',
          'oai-authenticated-user-email': 'Person@Example.com',
          'oai-authenticated-user-full-name': encodeURIComponent('张三'),
          'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8',
        },
      }),
    ),
    { id: 'stable-site-user', email: 'person@example.com', name: '张三' },
  );
});

test('Explicit workspace keeps stale tabs isolated after a global preference switch', async () => {
  const a = await bootstrap('tabs-a'),
    b = await bootstrap('tabs-b');
  const aid = a.user.tenant_id,
    bid = b.user.tenant_id;
  const invite = (await (
    await invoke('tabs-b', '/api/invitations', bid, 'POST', { email: 'tabs-a@example.com' })
  ).json()) as any;
  const accepted = await invoke('tabs-a', '/api/invitations/accept', undefined, 'POST', {
    token: invite.token,
  });
  assert.equal(accepted.status, 200);
  assert.equal(((await accepted.json()) as any).tenant_id, bid);
  assert.equal(
    (await invoke('tabs-a', '/api/records/skus', undefined, 'POST', { data: sku })).status,
    400,
  );
  assert.equal(
    (await invoke('tabs-a', '/api/records/skus', aid, 'POST', { data: sku })).status,
    200,
  );
  assert.equal(
    ((await (await invoke('tabs-a', '/api/state', aid)).json()) as any).records.skus.length,
    1,
  );
  assert.equal(
    ((await (await invoke('tabs-b', '/api/state', bid)).json()) as any).records.skus.length,
    0,
  );
  assert.equal((await invoke('tabs-b', '/api/state', aid)).status, 403);
  assert.equal((await invoke('tabs-a', '/api/export?workspace_id=' + aid)).status, 200);
  assert.equal((await invoke('tabs-a', '/api/export?workspace_id=' + bid, aid)).status, 400);
  assert.equal((await invoke('tabs-a', '/api/export')).status, 400);
});

test('Null JSON, invalid multipart and inherited schema keys return client errors', async () => {
  const state = await bootstrap('invalid-input'),
    id = state.user.tenant_id;
  assert.equal((await invoke('invalid-input', '/api/invitations', id, 'POST', null)).status, 422);
  assert.equal((await invoke('invalid-input', '/api/import', id, 'POST', {})).status, 422);
  assert.equal(
    (await invoke('invalid-input', '/api/records/constructor', id, 'POST', { data: sku })).status,
    404,
  );
});

test('Malformed settings and FIFO payloads cannot silently reset or commit business data', async () => {
  const initial = await bootstrap('typed-input'),
    id = initial.user.tenant_id;
  assert.equal(
    (
      await invoke('typed-input', '/api/settings', id, 'PUT', {
        version: initial.revision,
        data: { ...initial.settings, company_name: 'Preserve custom company', warning_days: 30 },
      })
    ).status,
    200,
  );
  assert.equal((await invoke('typed-input', '/api/demo', id, 'POST')).status, 200);
  const before = (await (await invoke('typed-input', '/api/state', id)).json()) as any;
  for (const data of [undefined, null, false, [], 'bad', 42]) {
    assert.equal(
      (
        await invoke('typed-input', '/api/settings', id, 'PUT', {
          version: before.revision,
          data,
        })
      ).status,
      422,
    );
  }
  const fifo = {
    sku: 'DEMO-A01',
    settlement_id: '示例结算001',
    month: '2026-05-01',
    quantity: 1,
    gross: '0',
    fees: '0',
    commit: false,
    revision: before.revision,
  };
  assert.equal((await invoke('typed-input', '/api/sales/fifo', id, 'POST', fifo)).status, 200);
  assert.equal(
    (
      await invoke('typed-input', '/api/sales/fifo', id, 'POST', {
        ...fifo,
        commit: 'false',
      })
    ).status,
    422,
  );
  for (const field of ['gross', 'fees']) {
    for (const value of [undefined, null, false, '', 'NaN', 'Infinity', '1000000000001']) {
      assert.equal(
        (
          await invoke('typed-input', '/api/sales/fifo', id, 'POST', {
            ...fifo,
            commit: true,
            [field]: value,
          })
        ).status,
        422,
      );
    }
  }
  const after = (await (await invoke('typed-input', '/api/state', id)).json()) as any;
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.settings, before.settings);
  assert.deepEqual(after.records, before.records);
});

test('Requests are bounded by bytes read even without Content-Length', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(256 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const source = new Request('http://local.test/api/import', {
    method: 'POST',
    body: stream,
    duplex: 'half',
  } as RequestInit);
  assert.equal(source.headers.has('Content-Length'), false);
  await assert.rejects(
    () => boundedRequest(source),
    (e: any) => e.status === 413,
  );
  assert.equal(cancelled, true);
  await assert.rejects(
    () =>
      boundedRequest(
        new Request('http://local.test', {
          method: 'POST',
          headers: { 'Content-Length': String(MAX_REQUEST_BYTES + 1) },
          body: 'x',
        }),
      ),
    (e: any) => e.status === 413,
  );
  await assert.rejects(
    () =>
      boundedRequest(
        new Request('http://local.test', {
          method: 'POST',
          headers: { 'Content-Length': 'invalid' },
          body: 'x',
        }),
      ),
    (e: any) => e.status === 400,
  );
  const valid = await boundedRequest(
    new Request('http://local.test', { method: 'POST', body: 'small body' }),
  );
  assert.equal(await valid.text(), 'small body');
});

test('Invitation consumption has exactly one winner and one audit entry', async () => {
  const owner = await bootstrap('claim-owner');
  await bootstrap('claim-user');
  const id = owner.user.tenant_id;
  const invite = (await (
    await invoke('claim-owner', '/api/invitations', id, 'POST', {
      email: 'claim-user@example.com',
      role: 'viewer',
    })
  ).json()) as any;
  const responses = await Promise.all(
    [1, 2].map(() =>
      invoke('claim-user', '/api/invitations/accept', undefined, 'POST', { token: invite.token }),
    ),
  );
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 422]);
  const events = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM audit WHERE workspace_id=? AND action='加入企业'",
  )
    .bind(id)
    .first<{ count: number }>();
  assert.equal(events?.count, 1);
  assert.equal(
    (
      await invoke('claim-owner', '/api/invitations', id, 'POST', {
        email: 'claim-user@example.com',
      })
    ).status,
    409,
  );
});

test('Revoking an invitation between lookup and claim cannot create membership or success', async () => {
  const owner = await bootstrap('revoked-owner');
  await bootstrap('revoked-user');
  const id = owner.user.tenant_id;
  const invite = (await (
    await invoke('revoked-owner', '/api/invitations', id, 'POST', {
      email: 'revoked-user@example.com',
    })
  ).json()) as any;
  let release!: () => void, reached!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const atBatch = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const proxy = new Proxy(env.DB, {
    get(target, key) {
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          reached();
          await blocked;
          return target.batch(statements);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const result = invoke(
    'revoked-user',
    '/api/invitations/accept',
    undefined,
    'POST',
    { token: invite.token },
    { ...env, DB: proxy },
  );
  await atBatch;
  await env.DB.prepare('DELETE FROM invitations WHERE token_hash=?')
    .bind(await hash(invite.token))
    .run();
  release();
  assert.equal((await result).status, 422);
  assert.equal(
    await env.DB.prepare('SELECT id FROM memberships WHERE workspace_id=? AND user_id=?')
      .bind(id, 'revoked-user')
      .first(),
    null,
  );
  const events = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM audit WHERE workspace_id=? AND action='加入企业'",
  )
    .bind(id)
    .first<{ count: number }>();
  assert.equal(events?.count, 0);
});

test('Save rechecks current write permission and owner-only changes inside its transaction', async () => {
  const owner = await bootstrap('permission-owner'),
    id = owner.user.tenant_id;
  const ctx = await context(request('permission-owner', '/api/state', id), env);
  const changed = structuredClone(ctx.records);
  changed.skus.push({ ...sku, id: crypto.randomUUID(), version: 1 });
  await env.DB.prepare("UPDATE memberships SET role='editor' WHERE workspace_id=? AND user_id=?")
    .bind(id, 'permission-owner')
    .run();
  await assert.rejects(
    () => save(ctx, changed, '修改企业参数', 'settings', null, null, ctx.settings, ctx.files, true),
    (e: any) => e.status === 409,
  );
  await env.DB.prepare('DELETE FROM memberships WHERE workspace_id=? AND user_id=?')
    .bind(id, 'permission-owner')
    .run();
  await assert.rejects(
    () => save(ctx, changed, '新增记录', 'skus'),
    (e: any) => e.status === 409,
  );
  const stored = await env.DB.prepare('SELECT data,revision FROM workspaces WHERE id=?')
    .bind(id)
    .first<{ data: string; revision: number }>();
  assert.equal(JSON.parse(stored!.data).records.skus.length, 0);
  assert.equal(stored!.revision, 0);
});

test('Removing a member revokes unused invitations and does not erase their other workspace', async () => {
  const owner = await bootstrap('remove-owner'),
    member = await bootstrap('remove-member');
  const id = owner.user.tenant_id;
  const invite = (await (
    await invoke('remove-owner', '/api/invitations', id, 'POST', {
      email: 'remove-member@example.com',
    })
  ).json()) as any;
  assert.equal(
    (
      await invoke('remove-member', '/api/invitations/accept', undefined, 'POST', {
        token: invite.token,
      })
    ).status,
    200,
  );
  // Simulate an unused invitation issued before the new duplicate-member guard.
  const oldToken = 'old-pending-token';
  await env.DB.prepare(
    'INSERT INTO invitations(token_hash,workspace_id,email,role,expires_at) VALUES(?,?,?,?,?)',
  )
    .bind(await hash(oldToken), id, 'remove-member@example.com', 'editor', Date.now() + 86400000)
    .run();
  assert.equal((await invoke('remove-owner', '/api/team/remove-member', id, 'DELETE')).status, 200);
  assert.equal((await invoke('remove-member', '/api/state', id)).status, 403);
  assert.equal(
    (
      await invoke('remove-member', '/api/invitations/accept', undefined, 'POST', {
        token: oldToken,
      })
    ).status,
    422,
  );
  assert.equal((await bootstrap('remove-member')).user.tenant_id, member.user.tenant_id);
});

test('Tenant-bound queries use indexes instead of scanning all tenants', async () => {
  const plan = await env.DB.prepare(
    "EXPLAIN QUERY PLAN SELECT id FROM audit WHERE workspace_id='test' ORDER BY created_at DESC,id DESC LIMIT 200",
  ).all<{ detail: string }>();
  assert(plan.results.some((row) => row.detail.includes('audit_workspace_created')));
  assert(
    !plan.results.some(
      (row) => row.detail.includes('SCAN audit') || row.detail.includes('TEMP B-TREE'),
    ),
  );
});

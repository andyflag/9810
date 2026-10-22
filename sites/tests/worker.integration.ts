// Run against `npm run dev` after applying local D1 migrations. Test identities
// emulate the trusted Sites dispatch headers only on the loopback test server.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const origin = 'http://127.0.0.1:8787';
const suffix = crypto.randomUUID();
const owner = 'owner-' + suffix,
  other = 'other-' + suffix,
  viewer = 'viewer-' + suffix;
async function request(user: string | null, path: string, method = 'GET', payload?: unknown) {
  const headers: Record<string, string> = { 'X-Requested-With': '9810' };
  if (user) {
    headers['oai-authenticated-user-id'] = user;
    headers['oai-authenticated-user-email'] = user + '@example.com';
  }
  let body: BodyInit | undefined;
  if (payload instanceof FormData) body = payload;
  else if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(payload);
  }
  return fetch(origin + path, { method, headers, body });
}
async function ok(user: string, path: string, method = 'GET', payload?: unknown) {
  const r = await request(user, path, method, payload);
  assert.equal(r.status, 200, await r.clone().text());
  return r.json() as Promise<any>;
}
const state = (user: string) => ok(user, '/api/state');
assert.equal((await request(null, '/api/state')).status, 401);
assert.equal((await fetch(origin + '/api/demo', { method: 'POST' })).status, 403);
assert.equal((await state(owner)).stats.export_count, 0);
await ok(owner, '/api/demo', 'POST');
const a = await state(owner);
assert.equal(a.stats.remaining, 608);
assert.deepEqual(a.stats.currencies.USD, { net_revenue: 17391, received: 10195, pending: 7196 });
assert.equal((await request(owner, '/api/demo', 'POST')).status, 409);
console.log('PASS authenticated bootstrap and demo calculations');

const form = new FormData();
form.append('file', new File(['company A confidential'], 'contract.txt', { type: 'text/plain' }));
const file = await ok(
  owner,
  '/api/documents/' + a.records.documents[0].id + '/files',
  'POST',
  form,
);
assert.equal(
  await (await request(owner, '/api/files/' + file.id)).text(),
  'company A confidential',
);
assert.equal((await state(other)).stats.export_count, 0);
assert.equal((await request(other, '/api/files/' + file.id)).status, 404);
assert.equal(
  (
    await request(other, '/api/records/skus/' + a.records.skus[0].id, 'PUT', {
      data: a.records.skus[0],
      version: 1,
    })
  ).status,
  404,
);
assert.equal(
  (await request(other, '/api/workspaces/switch', 'POST', { tenant_id: a.user.tenant_id })).status,
  403,
);
console.log('PASS D1 tenant isolation and R2 attachment storage');

const invitation = await ok(owner, '/api/invitations', 'POST', {
  email: viewer + '@example.com',
  role: 'viewer',
});
assert.equal(
  (await request(other, '/api/invitations/accept', 'POST', { token: invitation.token })).status,
  403,
);
await ok(viewer, '/api/invitations/accept', 'POST', { token: invitation.token });
assert.equal((await state(viewer)).user.role, 'viewer');
assert.equal((await state(viewer)).stats.remaining, 608);
assert.equal((await request(viewer, '/api/demo', 'POST')).status, 403);
assert.equal(
  (await request(viewer, '/api/settings', 'PUT', { data: a.settings, version: a.revision })).status,
  403,
);
assert.equal((await request(viewer, '/api/export')).status, 200);
assert.equal(
  (await request(viewer, '/api/invitations/accept', 'POST', { token: invitation.token })).status,
  422,
);
await ok(owner, '/api/team/' + viewer, 'DELETE');
assert.equal((await state(viewer)).stats.export_count, 0);
assert.equal((await request(viewer, '/api/files/' + file.id)).status, 404);
console.log('PASS invitation email binding, viewer permissions and immediate revocation');

const row = a.records.exports[0];
assert.equal(
  (await request(owner, '/api/records/exports/' + row.id + '?version=1', 'DELETE')).status,
  422,
);
const updates = await Promise.all(
  [1, 2].map((n) =>
    request(owner, '/api/records/exports/' + row.id, 'PUT', {
      data: { ...row, notes: 'concurrent ' + n },
      version: 1,
    }),
  ),
);
assert.deepEqual(updates.map((r) => r.status).sort(), [200, 409]);
assert.equal(
  (
    await request(owner, '/api/records/sales', 'POST', {
      data: { ...a.records.sales[0], sold_qty: 10000 },
    })
  ).status,
  422,
);
assert.equal((await state(owner)).records.sales.length, 3);
console.log('PASS concurrent update lock and inventory/dependency guards');

const importUser = 'import-' + suffix;
const sheet = new FormData();
sheet.append('file', new File([readFileSync('template.xlsx')], 'template.xlsx'));
assert.equal((await ok(importUser, '/api/import?dry_run=true', 'POST', sheet)).total, 13);
assert.equal((await state(importUser)).stats.export_count, 0);
assert.equal((await ok(importUser, '/api/import?dry_run=false', 'POST', sheet)).total, 13);
assert.equal((await ok(importUser, '/api/import?dry_run=false', 'POST', sheet)).skipped, 13);
const exported = await request(importUser, '/api/export');
const reimport = new FormData();
reimport.append('file', new File([await exported.arrayBuffer()], 'export.xlsx'));
assert.equal((await ok(importUser, '/api/import?dry_run=false', 'POST', reimport)).skipped, 13);
console.log('PASS Excel preview, commit, repeat import and export round trip');

await ok(owner, '/api/records/exports', 'POST', {
  data: {
    ...row,
    declaration_no: 'FIFO-LOT-2',
    export_date: '2026-04-01',
    quantity: 100,
    received_qty: 100,
  },
});
await ok(owner, '/api/records/receipts', 'POST', {
  data: {
    settlement_id: 'FIFO-SETTLEMENT',
    site: row.site,
    currency: row.currency,
    gross: '100.01',
  },
});
const fifo = {
  sku: row.sku,
  quantity: 350,
  gross: '100.01',
  fees: '0.03',
  month: '2026-05-01',
  settlement_id: 'FIFO-SETTLEMENT',
  sale_date: '2026-05-01',
  evidence_date: '2026-05-02',
};
const preview = await ok(owner, '/api/sales/fifo', 'POST', fifo);
assert.deepEqual(
  preview.rows.map((r: any) => r.sold_qty),
  [308, 42],
);
assert.equal(
  Math.round(preview.rows.reduce((a: number, r: any) => a + Number(r.gross), 0) * 100),
  10001,
);
await ok(owner, '/api/sales/fifo', 'POST', { ...fifo, commit: true, revision: preview.revision });
assert.equal(
  (
    await request(owner, '/api/sales/fifo', 'POST', {
      ...fifo,
      commit: true,
      revision: preview.revision,
    })
  ).status,
  409,
);
const events = await ok(owner, '/api/audit');
assert(events.some((r: any) => r.action === 'FIFO 销量分配'));
await ok(owner, '/api/files/' + file.id, 'DELETE');
assert.equal((await request(owner, '/api/files/' + file.id)).status, 404);
console.log('PASS FIFO cent allocation, stale preview protection, audit and attachment deletion');

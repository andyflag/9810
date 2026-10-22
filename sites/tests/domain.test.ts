import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import {
  compute,
  clean,
  DEFAULT_SETTINGS,
  validateState,
  RuleError,
  ORDER,
  emptyData,
} from '../server/domain';
import { parseWorkbook, mergeRecords, exportWorkbook } from '../server/excel';
import { identity, HttpError } from '../server/storage';
import fixtures from './fixtures/python-parity.json';

for (const fixture of fixtures) {
  test('Python parity: ' + fixture.name, () => {
    assert.deepEqual(compute(fixture.data, fixture.settings, fixture.today), fixture.expected);
  });
}
test('Excel template imports 13 original records and deduplicates a round trip', () => {
  const source = parseWorkbook(new Uint8Array(readFileSync('template.xlsx')));
  const { combined, added } = mergeRecords(emptyData(), source);
  assert.equal(added.length, 13);
  validateState(combined, DEFAULT_SETTINGS);
  combined.skus[0].notes = '=HYPERLINK("https://example.com","text")';
  const exported = exportWorkbook(combined, DEFAULT_SETTINGS);
  const wb = XLSX.read(exported, { type: 'array' });
  assert.equal(wb.Sheets['参数表']['I13'].t, 's');
  assert.equal(wb.Sheets['参数表']['I13'].f, undefined);
  const restored = parseWorkbook(exported);
  assert.deepEqual(compute(restored).stats, compute(combined).stats);
  assert.equal(mergeRecords(combined, restored).skipped, 13);
});
test('Data validation protects inventory, references, receipt dates and numbers', () => {
  const base = structuredClone(fixtures[0].data);
  base.exports[0].received_qty = 0;
  assert.throws(() => validateState(base, DEFAULT_SETTINGS), /库存不足/);
  base.exports[0].received_qty = 996;
  base.receipts[0].currency = 'EUR';
  assert.throws(() => validateState(base, DEFAULT_SETTINGS), /币种/);
  assert.throws(
    () => clean('skus', { sku: 'X', name: 'X', unit: '件', tax_rate: 'NaN' }),
    RuleError,
  );
  assert.throws(() => clean('receipts', { ...base.receipts[0], received_date: '' }), /入账日期/);
  assert.throws(() => parseWorkbook(new TextEncoder().encode('not xlsx')), RuleError);
});
test('Only the authenticated Sites user headers provide identity', () => {
  assert.throws(() => identity(new Request('https://example.test/api/state')), HttpError);
  assert.throws(
    () =>
      identity(
        new Request('https://example.test/api/state', {
          headers: { Authorization: 'Bearer service-token' },
        }),
      ),
    HttpError,
  );
  const user = identity(
    new Request('https://example.test/api/state', {
      headers: {
        'oai-authenticated-user-id': 'owner',
        'oai-authenticated-user-email': 'Owner@Example.com',
        'oai-authenticated-user-full-name': encodeURIComponent('测试用户'),
        'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8',
      },
    }),
  );
  assert.deepEqual(user, { id: 'owner', email: 'owner@example.com', name: '测试用户' });
});

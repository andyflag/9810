import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { zipSync, unzipSync } from 'fflate';
import {
  allocateMoney,
  clean,
  compute,
  DEFAULT_SETTINGS,
  D,
  emptyData,
  NORMAL,
  ORDER,
  SCHEMA,
  validateState,
} from '../server/domain';
import { exportWorkbook, mergeRecords, parseWorkbook } from '../server/excel';
const raw = JSON.parse(readFileSync('server/sample.json', 'utf8'));
const sample = () =>
  Object.fromEntries(ORDER.map((k) => [k, raw[k].map((row: any) => clean(k, row))]));
const original = () => new Uint8Array(readFileSync('template.xlsx'));
const write = (book: XLSX.WorkBook) =>
  new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx', compression: true }));

test('Cent allocation conserves positive and signed cash without negative positive rows', () => {
  assert.deepEqual(allocateMoney('0.02', [1, 1, 1, 1]), [0.01, 0.01, 0, 0]);
  for (const amount of ['0.02', '-0.02', '10.005', '-10.005', '0.005', '-0.005']) {
    const result = allocateMoney(amount, [1, 1, 1, 1]);
    assert.equal(
      result.reduce((sum, value) => sum.plus(value), D(0)).toFixed(2),
      D(amount).toDecimalPlaces(2).toFixed(2),
    );
    assert(result.every((value) => (D(amount).lt(0) ? value <= 0 : value >= 0)));
  }
  const signed = allocateMoney('0.02', ['0.04', '-0.01', '0.01']);
  assert(signed[0] >= 0 && signed[1] <= 0 && signed[2] >= 0);
  assert.equal(signed.reduce((sum, value) => sum.plus(value), D(0)).toNumber(), 0.02);
  assert.deepEqual(allocateMoney('10', [1, 1], 4), [2.5, 2.5]);
});

test('Four one-cent sales cannot receive a negative cash allocation', () => {
  const data = sample(),
    first = data.sales[0];
  data.sales = Array.from({ length: 4 }, () => ({
    ...first,
    sold_qty: 1,
    returned_qty: 0,
    gross: '0.01',
    fees: '0',
  }));
  data.receipts = [
    {
      ...data.receipts[0],
      gross: '0.04',
      commission: '0',
      fulfillment: '0',
      storage: '0',
      advertising: '0',
      refunds: '0',
      other_fees: '0',
      received_amount: '0.02',
    },
  ];
  const rows = validateState(data, DEFAULT_SETTINGS).records.sales;
  assert.deepEqual(
    rows.map((row) => row.received_allocated),
    [0.01, 0.01, 0, 0],
  );
});

test('Same-day tax allocation survives regenerated IDs and Excel round trips', () => {
  const data = sample(),
    first = data.taxes[0];
  data.taxes = [
    { ...first, id: 'z', reference: 'FIRST', quantity: 500, amount: '500' },
    { ...first, id: 'a', reference: 'SECOND', quantity: 500, amount: '1000' },
  ];
  const summary = (rows: any) =>
    compute(rows).records.taxes.map((row) => [row.reference, row.sold_qty, row.reference_amount]);
  assert.deepEqual(summary(data), [
    ['FIRST', 500, 500],
    ['SECOND', 185, 370],
  ]);
  const imported = mergeRecords(
    emptyData(),
    parseWorkbook(exportWorkbook(data, DEFAULT_SETTINGS)),
  ).combined;
  assert.deepEqual(summary(imported), summary(data));
});

test('Normal declaration reversals cannot expand prepaid allocations beyond actual sales', () => {
  const cases = [
    { normal: [-100], sold: 685, expected: 685 },
    { normal: [100, -100], sold: 685, expected: 685 },
    { normal: [100], sold: 685, expected: 585 },
    { normal: [1000], sold: 685, expected: 0 },
    { normal: [-100], sold: 0, expected: 0 },
  ];
  for (const scenario of cases) {
    const data = sample(),
      first = data.taxes[0];
    data.taxes = [
      { ...first, reference: 'PRE-1', quantity: 500, amount: '2340' },
      { ...first, reference: 'PRE-2', quantity: 500, amount: '2340' },
      ...scenario.normal.map((quantity, i) => ({
        ...first,
        method: NORMAL,
        reference: `NORMAL-${i}`,
        quantity,
        amount: D(quantity).mul('4.68').toFixed(),
      })),
    ];
    if (!scenario.sold)
      for (const row of data.sales)
        if (row.ledger_id === first.ledger_id) row.returned_qty = row.sold_qty;
    const state = validateState(data, DEFAULT_SETTINGS);
    const prepaid = state.records.taxes.slice(0, 2);
    assert.deepEqual(
      prepaid.map((row) => row.sold_qty),
      [Math.min(500, scenario.expected), Math.max(0, scenario.expected - 500)],
    );
    assert.equal(
      prepaid.reduce((sum, row) => sum.plus(row.reference_amount), D(0)).toNumber(),
      D(scenario.expected).mul('4.68').toNumber(),
    );
    const alerts = state.ledger
      .find((row) => row.ledger_id === first.ledger_id)!
      .alerts.filter((alert: any) => alert.text.startsWith('正常申报累计数量为'));
    const normal = scenario.normal.reduce((sum, quantity) => sum + quantity, 0);
    assert.deepEqual(
      alerts,
      normal < 0
        ? [
            {
              level: 'warning',
              text: `正常申报累计数量为 ${normal} 件，请核对冲减记录；预退税可分配销量按实际净销量 ${scenario.sold} 件封顶`,
            },
          ]
        : [],
    );
  }
});

test('Every supplied manual column heading is validated; legacy optional extensions stay compatible', () => {
  assert.equal(parseWorkbook(original()).exports.length, 2);
  const book = XLSX.read(exportWorkbook(sample(), DEFAULT_SETTINGS), { type: 'array' });
  const spec = SCHEMA.receipts,
    sheet = book.Sheets[spec.sheet];
  const columns = ['received_amount', 'exchange_rate'].map(
    (key) => spec.fields.find((f: any) => f.key === key).column - 1,
  );
  for (let row = spec.header_row - 1; row <= XLSX.utils.decode_range(sheet['!ref']!).e.r; row++) {
    const [a, b] = columns.map((column) => XLSX.utils.encode_cell({ r: row, c: column }));
    [sheet[a], sheet[b]] = [sheet[b], sheet[a]];
  }
  assert.throws(() => parseWorkbook(write(book)), /表头不匹配/);
});

test('Eight-decimal source amounts above Excel precision remain lossless and deduplicate', () => {
  const data = sample();
  data.exports[0].fob = '99999999999.12345678';
  const bytes = exportWorkbook(data, DEFAULT_SETTINGS);
  const parsed = parseWorkbook(bytes);
  assert.equal(parsed.exports[0].fob, data.exports[0].fob);
  assert.equal(mergeRecords(data, parsed).skipped, 13);
  const book = XLSX.read(bytes, { type: 'array' }),
    spec = SCHEMA.exports;
  const column = spec.fields.find((f: any) => f.key === 'fob').column - 1;
  assert.equal(
    book.Sheets[spec.sheet][XLSX.utils.encode_cell({ r: spec.header_row, c: column })].t,
    's',
  );
});

test('Prototype property names cannot stand in for missing ledger or settlement records', () => {
  for (const key of ['constructor', '__proto__', 'toString']) {
    for (const kind of ['taxes', 'exceptions']) {
      const data = sample();
      data[kind][0].ledger_id = key;
      assert.throws(() => validateState(data, DEFAULT_SETTINGS), /核销编号不存在/);
    }
    const data = sample();
    data.sales[0].settlement_id = key;
    const state = validateState(data, DEFAULT_SETTINGS);
    assert.equal(state.records.sales[0].received_allocated, 0);
    assert(state.ledger[0].alerts.some((alert: any) => alert.text === '结算报告未登记'));
  }
});

function entries(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (view.getUint32(end, true) !== 0x06054b50) end--;
  const result: { offset: number; local: number; next: number; name: string }[] = [];
  let offset = view.getUint32(end + 16, true);
  for (let i = 0; i < view.getUint16(end + 10, true); i++) {
    const length = view.getUint16(offset + 28, true),
      extra = view.getUint16(offset + 30, true),
      comment = view.getUint16(offset + 32, true);
    const next = offset + 46 + length + extra + comment;
    result.push({
      offset,
      local: view.getUint32(offset + 42, true),
      next,
      name: new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + length)),
    });
    offset = next;
  }
  return { result, end };
}
function withPadding() {
  return zipSync({ ...unzipSync(original()), 'padding.bin': new Uint8Array(1024 * 1024) });
}

test('ZIP per-disk and total counts cannot bypass the expansion preflight', () => {
  const bytes = withPadding(),
    { end } = entries(bytes);
  new DataView(bytes.buffer).setUint16(end + 10, 0, true);
  assert.throws(() => parseWorkbook(bytes), /ZIP 结构无效/);
});

test('ZIP claimed zero or small sizes and inconsistent local headers are rejected before SheetJS', () => {
  for (const claimed of [0, 1]) {
    const bytes = withPadding(),
      entry = entries(bytes).result.find((row) => row.name === 'padding.bin')!;
    const view = new DataView(bytes.buffer);
    view.setUint32(entry.offset + 24, claimed, true);
    view.setUint32(entry.local + 22, claimed, true);
    assert.throws(() => parseWorkbook(bytes), /解压大小与文件声明不一致/);
  }
  const bytes = withPadding(),
    entry = entries(bytes).result.find((row) => row.name === 'padding.bin')!;
  new DataView(bytes.buffer).setUint32(entry.local + 22, 0x7fffffff, true);
  assert.throws(() => parseWorkbook(bytes), /ZIP 结构无效/);
});

test('ZIP entry CRC is verified even when both headers carry the same forged checksum', () => {
  const bytes = withPadding(),
    entry = entries(bytes).result.find((row) => row.name === 'padding.bin')!;
  const view = new DataView(bytes.buffer),
    checksum = (view.getUint32(entry.offset + 16, true) ^ 0xff) >>> 0;
  view.setUint32(entry.offset + 16, checksum, true);
  view.setUint32(entry.local + 14, checksum, true);
  assert.throws(() => parseWorkbook(bytes), /内容校验失败/);
});

function streamingZip(bytes: Uint8Array) {
  const { result, end } = entries(bytes),
    view = new DataView(bytes.buffer);
  const parts: Uint8Array[] = [],
    directories: Uint8Array[] = [];
  let offset = 0;
  for (const entry of result) {
    const localLength =
      30 + view.getUint16(entry.local + 26, true) + view.getUint16(entry.local + 28, true);
    const header = bytes.slice(entry.local, entry.local + localLength),
      hv = new DataView(header.buffer);
    const compressed = view.getUint32(entry.offset + 20, true),
      size = view.getUint32(entry.offset + 24, true),
      checksum = view.getUint32(entry.offset + 16, true);
    hv.setUint16(6, hv.getUint16(6, true) | 8, true);
    hv.setUint32(14, 0, true);
    hv.setUint32(18, 0, true);
    hv.setUint32(22, 0, true);
    const descriptor = new Uint8Array(16),
      dv = new DataView(descriptor.buffer);
    [0x08074b50, checksum, compressed, size].forEach((value, i) =>
      dv.setUint32(i * 4, value, true),
    );
    const directory = bytes.slice(entry.offset, entry.next),
      cv = new DataView(directory.buffer);
    cv.setUint16(8, cv.getUint16(8, true) | 8, true);
    cv.setUint32(42, offset, true);
    const payload = bytes.slice(entry.local + localLength, entry.local + localLength + compressed);
    parts.push(header, payload, descriptor);
    directories.push(directory);
    offset += header.length + payload.length + descriptor.length;
  }
  const suffix = bytes.slice(end),
    ev = new DataView(suffix.buffer);
  ev.setUint32(16, offset, true);
  ev.setUint32(
    12,
    directories.reduce((sum, part) => sum + part.length, 0),
    true,
  );
  const chunks = [...parts, ...directories, suffix],
    joined = new Uint8Array(chunks.reduce((sum, part) => sum + part.length, 0));
  let position = 0;
  for (const chunk of chunks) {
    joined.set(chunk, position);
    position += chunk.length;
  }
  return joined;
}

test('Valid streaming ZIP descriptors and genuinely empty deflate entries remain supported', () => {
  const bytes = zipSync({ ...unzipSync(original()), 'empty.txt': new Uint8Array() });
  assert.equal(parseWorkbook(streamingZip(bytes)).exports.length, 2);
});

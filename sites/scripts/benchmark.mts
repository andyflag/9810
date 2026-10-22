// Local compute benchmark only; this does not measure production HTTP latency.
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
const { compute, emptyData, PRE } = await import(process.argv[2] || '../server/domain.ts');
const data = emptyData();
data.skus.push({ sku: 'BENCH', name: '性能样本', unit: '件', tax_rate: '0.13' });
for (let i = 0; i < 1000; i++) {
  const id = `BENCH-${i}-1`,
    settlement_id = `SET-${i}`;
  data.exports.push({
    declaration_no: `BENCH-${i}`,
    item_no: 1,
    sku: 'BENCH',
    export_date: '2026-01-01',
    quantity: 100,
    received_qty: 100,
    currency: 'USD',
    fob: '100',
    exchange_rate: '7',
    invoice_amount: '700',
  });
  data.receipts.push({
    settlement_id,
    gross: '30',
    received_amount: '15',
    received_date: '2026-02-01',
    currency: 'USD',
  });
  for (let j = 0; j < 3; j++)
    data.sales.push({
      month: '2026-01-01',
      settlement_id,
      sku: 'BENCH',
      ledger_id: id,
      sold_qty: 10,
      returned_qty: 0,
      gross: '10',
      fees: '0',
    });
  data.taxes.push({
    ledger_id: id,
    declaration_date: '2026-01-01',
    completed_date: '2026-02-01',
    quantity: 100,
    amount: '91',
    method: PRE,
  });
}
for (let i = 0; i < 3; i++) compute(data, undefined, '2026-10-22');
const times = [];
let result;
for (let i = 0; i < 7; i++) {
  const start = performance.now();
  result = compute(data, undefined, '2026-10-22');
  times.push(performance.now() - start);
}
times.sort((a, b) => a - b);
const report = {
  records: Object.values(data).reduce((n, a) => n + a.length, 0),
  bytes: Buffer.byteLength(JSON.stringify(data)),
  median_ms: Math.round(times[3] * 100) / 100,
  samples: times.map((x) => Math.round(x * 100) / 100),
  stats: result.stats,
};
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));

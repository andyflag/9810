import Decimal from 'decimal.js';
import schema from './schema.json';
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Row = Record<string, any>;
export const SCHEMA: Record<string, any> = schema;
export const ORDER = ['skus', 'exports', 'receipts', 'sales', 'taxes', 'exceptions', 'documents'];
export const PRE = '未售-海外仓预退（HWC-YT）',
  NORMAL = '已售-按现行规定申报';
export const DEFAULT_SETTINGS: Row = {
  company_name: '我的企业',
  company_type: '外贸企业',
  shop_name: '',
  tax_authority: '',
  filing_date: '',
  warning_days: 60,
  evidence_days: 15,
  retention_years: 10,
  deadline_month: 4,
  deadline_day: 30,
};
export class RuleError extends Error {
  status = 422;
}
export const D = (v: any = 0) => new Decimal(v || 0);
export const money = (v: any) => D(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
export const total = (rows: Row[], key: string) =>
  rows.reduce<Decimal>((s, r) => s.plus(D(r[key])), D(0));
/** Allocate rounded cents by largest remainder, including signed refund rows.
 * A separate denominator preserves partially allocated settlement totals. */
export function allocateMoney(amount: any, weights: any[], denominator?: any): number[] {
  const divisor =
    denominator === undefined
      ? weights.reduce<Decimal>((sum, value) => sum.plus(D(value)), D(0))
      : D(denominator);
  if (!weights.length || divisor.lte(0)) return weights.map(() => 0);
  const numerators = weights.map((value) => D(amount).mul(100).mul(D(value)));
  const cents = numerators.map((value) => value.div(divisor).floor());
  const numeratorTotal = numerators.reduce((sum, value) => sum.plus(value), D(0));
  let target = numeratorTotal.divToInt(divisor);
  const remainder = numeratorTotal.minus(target.mul(divisor));
  if (remainder.abs().mul(2).gte(divisor))
    target = target.plus(numeratorTotal.isNegative() ? -1 : 1);
  const remaining = target.minus(cents.reduce((sum, value) => sum.plus(value), D(0))).toNumber();
  const order = numerators
    .map((value, index) => ({
      index,
      remainder: value.minus(cents[index].mul(divisor)),
    }))
    .sort((a, b) => b.remainder.cmp(a.remainder) || a.index - b.index);
  for (let i = 0; i < remaining; i++) cents[order[i].index] = cents[order[i].index].plus(1);
  return cents.map((value) => (value.isZero() ? 0 : value.div(100).toNumber()));
}
export const present = (v: any) => v !== null && v !== undefined && v !== '';
export const todayCN = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
const days = (start: string, end: string) =>
  (Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000;
const addDays = (s: string, n: number) =>
  new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const validDate = (v: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number(v.slice(0, 4)) > 0 &&
  !isNaN(Date.parse(v + 'T00:00:00Z')) &&
  new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
const deadline = (v: any, s: Row) =>
  v
    ? `${Number(v.slice(0, 4)) + 1}-${String(s.deadline_month).padStart(2, '0')}-${String(s.deadline_day).padStart(2, '0')}`
    : null;
function addYears(v: string, n: number) {
  let result = Number(v.slice(0, 4)) + n + v.slice(4);
  return validDate(result) ? result : result.slice(0, 8) + '28';
}
export function emptyData() {
  return Object.fromEntries(ORDER.map((k) => [k, []])) as Record<string, Row[]>;
}
export function clean(kind: string, payload: Row) {
  if (!SCHEMA[kind] || !payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new RuleError('不支持的台账或数据格式');
  const result: Row = {};
  for (const f of SCHEMA[kind].fields) {
    if (f.computed) continue;
    const key = f.key;
    let value = payload[key];
    if (!present(value)) {
      if (f.required) throw new RuleError(`${f.label}为必填项`);
      continue;
    }
    try {
      if (['number', 'integer'].includes(f.type)) {
        const n = D(value);
        if (!n.isFinite() || n.abs().gt('1000000000000')) throw Error();
        if (f.type === 'integer') {
          if (!n.isInteger()) throw Error();
          value = n.toNumber();
        } else {
          if (n.decimalPlaces() > 8) throw Error();
          value = n.toFixed();
        }
      } else if (f.type === 'date') {
        value = String(value);
        if (!validDate(value)) throw Error();
        if (kind === 'sales' && key === 'month') value = value.slice(0, 8) + '01';
      } else {
        value = String(value).trim();
        if (value.length > 2000 || (f.required && !value)) throw Error();
      }
    } catch {
      throw new RuleError(`${f.label}格式不正确（数值最多 8 位小数）`);
    }
    if (f.options && !f.options.includes(value)) throw new RuleError(`${f.label}不在允许选项中`);
    result[key] = value;
  }
  for (const key of ['quantity', 'received_qty', 'sold_qty', 'returned_qty', 'item_no'])
    if (key in result && D(result[key]).lt(0) && kind !== 'taxes')
      throw new RuleError(`${key} 不得小于 0`);
  if (kind === 'skus' && (D(result.tax_rate).lt(0) || D(result.tax_rate).gt(1)))
    throw new RuleError('退税率应在 0 到 1 之间');
  if (kind === 'exports') {
    if (result.item_no < 1 || result.quantity <= 0) throw new RuleError('项号和报关数量必须大于 0');
    result.trade_mode ??= '9810';
    if (result.trade_mode !== '9810') throw new RuleError('本台账仅适用于 9810 监管方式');
  }
  if ('exchange_rate' in result && D(result.exchange_rate).lte(0))
    throw new RuleError('汇率必须大于 0');
  if (kind === 'taxes' && result.method === PRE && (result.quantity <= 0 || D(result.amount).lt(0)))
    throw new RuleError('预退税申报数量须大于 0，金额不得为负');
  if (kind === 'receipts') {
    if (result.period_start && result.period_end && result.period_end < result.period_start)
      throw new RuleError('结算结束日期不得早于开始日期');
    if (present(result.received_amount) && !result.received_date)
      throw new RuleError('填写入境金额时必须同时填写境内银行入账日期');
    if (result.received_date && !present(result.received_amount))
      throw new RuleError('填写境内银行入账日期时必须同时填写入境金额');
    if (D(result.received_amount).lt(0))
      throw new RuleError('境内入账金额不得为负；退汇请调整原入账金额并备注');
  }
  const pairs: Record<string, string[][]> = {
    exports: [['export_date', 'received_date']],
    sales: [['sale_date', 'evidence_date']],
    taxes: [
      ['declaration_date', 'completed_date'],
      ['completed_date', 'reconciled_date'],
    ],
    documents: [['declaration_date', 'completed_date']],
  };
  const labels = Object.fromEntries(SCHEMA[kind].fields.map((f: Row) => [f.key, f.label]));
  for (const [a, b] of pairs[kind] || [])
    if (result[a] && result[b] && result[b] < result[a])
      throw new RuleError(`${labels[b]}不得早于${labels[a]}`);
  return result;
}
export function cleanSettings(payload: Row) {
  const s = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(s)) if (k in payload) s[k] = payload[k];
  if (!['外贸企业', '生产企业'].includes(s.company_type)) throw new RuleError('企业类型无效');
  for (const k of ['company_name', 'shop_name', 'tax_authority', 'filing_date']) {
    s[k] = String(s[k]).trim();
    if (s[k].length > 200) throw new RuleError('企业信息过长');
  }
  if (!s.company_name) throw new RuleError('企业名称不能为空');
  if (s.filing_date && !validDate(s.filing_date)) throw new RuleError('备案日期格式不正确');
  for (const [k, low, high] of [
    ['warning_days', 1, 365],
    ['evidence_days', 1, 90],
    ['retention_years', 1, 30],
    ['deadline_month', 1, 12],
    ['deadline_day', 1, 31],
  ] as [string, number, number][]) {
    const n = Number(s[k]);
    if (!Number.isInteger(n) || n < low || n > high) throw new RuleError(`${k} 超出允许范围`);
    s[k] = n;
  }
  if (!validDate(deadline('2026-01-01', s)!)) throw new RuleError('截止日必须是每年都存在的日期');
  return s;
}
function groupRows(rows: Row[], key: string): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const group = groups.get(row[key]);
    if (group) group.push(row);
    else groups.set(row[key], [row]);
  }
  return groups;
}
export function compute(
  input: Record<string, Row[]>,
  settings: Row = DEFAULT_SETTINGS,
  today = todayCN(),
) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const data = Object.fromEntries(ORDER.map((k) => [k, structuredClone(input[k] || [])])) as Record<
    string,
    Row[]
  >;
  const skuIndex = new Map(data.skus.map((r) => [r.sku, r]));
  const salesByLedger = groupRows(data.sales, 'ledger_id');
  const salesBySettlement = groupRows(data.sales, 'settlement_id');
  const taxesByLedger = groupRows(data.taxes, 'ledger_id');
  const exceptionsByLedger = groupRows(data.exceptions, 'ledger_id');
  const documentsByDeclaration = new Map(data.documents.map((r) => [r.declaration_no, r]));
  const receiptsBySettlement = new Map(data.receipts.map((r) => [r.settlement_id, r]));
  const exports: Record<string, Row> = Object.create(null);
  for (const r of data.exports) {
    const sku = skuIndex.get(r.sku) || {};
    Object.assign(r, {
      ledger_id: `${r.declaration_no}-${r.item_no}`,
      name: sku.name ?? 'SKU未建档',
      hs_code: sku.hs_code ?? null,
      unit: sku.unit ?? null,
      tax_rate: sku.tax_rate ?? null,
    });
    r.fob_cny = money(D(r.fob).mul(D(r.exchange_rate)));
    r.tax_basis = s.company_type === '外贸企业' ? (r.invoice_amount ?? null) : r.fob_cny;
    r.expected_tax = present(r.tax_basis) ? money(D(r.tax_basis).mul(D(r.tax_rate))) : null;
    r.warehouse_difference = present(r.received_qty)
      ? Number(r.received_qty) - Number(r.quantity)
      : null;
    exports[r.ledger_id] = r;
  }
  for (const r of data.sales) {
    r.net_qty = Number(r.sold_qty || 0) - Number(r.returned_qty || 0);
    r.net_amount = money(D(r.gross).minus(D(r.fees)));
    r.sku_check = exports[r.ledger_id]?.sku === r.sku ? '一致' : 'SKU与报关单不符';
    r.evidence_status =
      r.sale_date && r.evidence_date
        ? days(r.sale_date, r.evidence_date) <= s.evidence_days
          ? '及时'
          : '超期'
        : r.sale_date
          ? days(r.sale_date, today) > s.evidence_days
            ? '已超期未留存'
            : '待留存'
          : '未填写销售日期';
    r.received_allocated = 0;
    r.receipt_status = '待收汇';
  }
  for (const r of data.receipts) {
    r.net_amount = money(
      D(r.gross).minus(
        ['commission', 'fulfillment', 'storage', 'advertising', 'refunds', 'other_fees'].reduce(
          (a, k) => a.plus(D(r[k])),
          D(0),
        ),
      ),
    );
    const related = salesBySettlement.get(r.settlement_id) || [];
    r.allocated = money(total(related, 'net_amount'));
    r.allocation_difference = money(D(r.net_amount).minus(D(r.allocated)));
    r.converted_amount =
      present(r.received_amount) && present(r.exchange_rate)
        ? money(D(r.received_amount).mul(D(r.exchange_rate)))
        : null;
    const received = r.received_date
      ? Decimal.min(D(r.received_amount), Decimal.max(0, D(r.net_amount)))
      : D(0);
    const denominator = Decimal.max(D(r.net_amount), D(r.allocated));
    const ratio = denominator.gt(0) ? received.div(denominator) : D(0);
    const allocations = allocateMoney(
      received,
      related.map((t) => t.net_amount),
      denominator,
    );
    related.forEach((t, i) => {
      t.received_allocated = allocations[i];
      t.receipt_status = ratio.gte(1) ? '已收汇' : ratio.gt(0) ? '部分收汇' : '待收汇';
    });
  }
  const taxRemaining: Record<string, Decimal> = Object.create(null);
  const negativeNormalQuantities = new Map<string, Decimal>();
  for (const id of Object.keys(exports)) {
    const sold = total(salesByLedger.get(id) || [], 'net_qty');
    const normal = total(
      (taxesByLedger.get(id) || []).filter((r) => r.method === NORMAL),
      'quantity',
    );
    taxRemaining[id] = Decimal.max(0, Decimal.min(sold, sold.minus(normal)));
    if (normal.lt(0)) negativeNormalQuantities.set(id, normal);
  }
  for (const r of [...data.taxes].sort((a, b) =>
    a.declaration_date.localeCompare(b.declaration_date),
  )) {
    const e = exports[r.ledger_id] || {};
    r.sku = e.sku ?? null;
    r.export_date = e.export_date ?? null;
    r.receipt_deadline = deadline(e.export_date, s);
    r.difference = present(r.actual_amount) ? money(D(r.actual_amount).minus(D(r.amount))) : null;
    r.deadline = r.method === PRE ? r.deadline_override || deadline(r.completed_date, s) : null;
    r.days_left = r.deadline && !r.reconciled_date ? days(today, r.deadline) : null;
    r.sold_qty = null;
    r.reference_amount = null;
    r.action = '按现行规定申报';
    if (r.method === PRE) {
      const sold = Decimal.min(D(r.quantity), taxRemaining[r.ledger_id] || D(0));
      taxRemaining[r.ledger_id] = (taxRemaining[r.ledger_id] || D(0)).minus(sold);
      r.sold_qty = sold.toNumber();
      r.reference_amount = r.quantity ? money(D(r.amount).div(D(r.quantity)).mul(sold)) : 0;
      r.action = sold.isZero()
        ? '仍未销售：需要调整申报，全额缴回预退税'
        : sold.lt(D(r.quantity))
          ? '部分已售：需要调整申报，全额冲减后按已售部分重报'
          : r.difference === null
            ? '全部已售：填写实际应退税额后判断'
            : r.difference === 0
              ? '全部已售、无差异：无需调整申报'
              : '全部已售、有差异：需要调整申报';
    }
    r.status =
      r.method !== PRE
        ? '不涉及核算'
        : r.reconciled_date
          ? '已核算'
          : !r.deadline
            ? '待税务办结'
            : r.days_left < 0
              ? '已逾期'
              : r.days_left <= s.warning_days
                ? '临近截止'
                : '待核算';
  }
  for (const r of data.exceptions) r.sku = exports[r.ledger_id]?.sku ?? null;
  const docKeys = SCHEMA.documents.fields
    .filter((f: Row) => f.column >= 4 && f.column <= 12)
    .map((f: Row) => f.key);
  for (const r of data.documents) {
    const missing = docKeys.filter((k: string) => !present(r[k]) || r[k] === '未留存').length,
      pending = docKeys.filter((k: string) => r[k] === '陆续留存中').length;
    r.completeness = missing ? `缺${missing}项` : pending ? `留存中（${pending}项）` : '齐全';
    r.deadline = addDays(r.declaration_date, s.evidence_days);
    r.retention_date = addYears(r.declaration_date, s.retention_years);
    const complete = !missing && !pending ? r.completed_date : null;
    r.timeliness = complete
      ? complete <= r.deadline
        ? '按时'
        : '超期'
      : today > r.deadline
        ? '已超期未完成'
        : '待完成';
  }
  const ledger: Row[] = [];
  for (const e of data.exports) {
    const ss = salesByLedger.get(e.ledger_id) || [],
      ts = taxesByLedger.get(e.ledger_id) || [],
      ps = ts.filter((r) => r.method === PRE),
      xs = exceptionsByLedger.get(e.ledger_id) || [],
      ds = documentsByDeclaration.get(e.declaration_no);
    const r: Row = {
      ...e,
      net_sold: total(ss, 'net_qty').toNumber(),
      exception_qty: total(xs, 'quantity').toNumber(),
      net_revenue: money(total(ss, 'net_amount')),
      received_amount: money(total(ss, 'received_allocated')),
      declared_tax: money(total(ts, 'amount')),
      prepaid_tax: money(total(ps, 'amount')),
      receipt_deadline: deadline(e.export_date, s),
    };
    r.remaining = Number(e.received_qty ?? e.quantity) - r.net_sold - r.exception_qty;
    r.progress = Number(((r.net_sold / e.quantity) * 100).toFixed(1));
    const overdue = today > r.receipt_deadline;
    r.receipt_status = !r.net_sold
      ? overdue
        ? '超过收汇期限仍未销售'
        : '尚未销售'
      : r.received_amount >= r.net_revenue
        ? '已售部分已收汇'
        : overdue
          ? '超期未收汇'
          : '有回款待收汇';
    r.tax_status =
      ['已逾期', '临近截止', '待税务办结', '待核算'].find((v) => ps.some((t) => t.status === v)) ||
      (ps.length ? '已核算' : '不涉及');
    r.tax_deadline =
      ps
        .filter((t) => t.deadline && !t.reconciled_date)
        .map((t) => t.deadline)
        .sort()[0] || null;
    r.document_status = ds?.completeness || '未登记';
    const alerts: Row[] = [];
    const add = (level: string, text: string) => alerts.push({ level, text });
    if (overdue && r.receipt_status !== '已售部分已收汇') add('danger', '收汇超期');
    if (r.tax_status === '已逾期') add('danger', '核算逾期');
    if (r.tax_status === '临近截止') add('warning', '核算临近截止');
    if (r.document_status !== '齐全') add('warning', '单证' + r.document_status);
    if (ds && ['超期', '已超期未完成'].includes(ds.timeliness)) add('danger', '单证留存超期');
    if (e.warehouse_difference)
      add('warning', `入仓差异 ${e.warehouse_difference > 0 ? '+' : ''}${e.warehouse_difference}`);
    if (!present(e.received_qty)) add('info', '待 FBA 签收');
    if (ss.some((t) => ['超期', '已超期未留存'].includes(t.evidence_status)))
      add('warning', '销售佐证超期');
    if (xs.some((t) => t.tax_adjustment === '待处理')) add('warning', '异常退税待处理');
    const negativeNormal = negativeNormalQuantities.get(e.ledger_id);
    if (negativeNormal)
      add(
        'warning',
        `正常申报累计数量为 ${negativeNormal.toFixed()} 件，请核对冲减记录；预退税可分配销量按实际净销量 ${r.net_sold} 件封顶`,
      );
    const ids = new Set(ss.map((t) => t.settlement_id)),
      linked = [...ids].flatMap((id) => {
        const receipt = receiptsBySettlement.get(id);
        return receipt ? [receipt] : [];
      });
    if (linked.some((t) => t.allocation_difference !== 0)) add('warning', '结算分摊差异');
    if (linked.length !== ids.size) add('warning', '结算报告未登记');
    if (linked.some((t) => D(t.received_amount).gt(D(t.net_amount))))
      add('warning', '入账金额大于结算净额');
    r.alerts = alerts;
    ledger.push(r);
  }
  const currencies: Row = {};
  const byCurrency = groupRows(ledger, 'currency');
  for (const c of [...byCurrency.keys()].sort()) {
    const group = byCurrency.get(c)!;
    currencies[c] = {
      net_revenue: money(total(group, 'net_revenue')),
      received: money(total(group, 'received_amount')),
      pending: money(total(group, 'net_revenue').minus(total(group, 'received_amount'))),
    };
  }
  return {
    records: data,
    ledger,
    stats: {
      export_count: ledger.length,
      quantity: total(ledger, 'quantity').toNumber(),
      net_sold: total(ledger, 'net_sold').toNumber(),
      remaining: total(ledger, 'remaining').toNumber(),
      declared_tax: money(total(ledger, 'declared_tax')),
      prepaid_tax: money(total(ledger, 'prepaid_tax')),
      pending_tax: ledger.filter((r) =>
        ['待税务办结', '待核算', '临近截止', '已逾期'].includes(r.tax_status),
      ).length,
      risk_count: ledger.filter((r) => r.alerts.length).length,
      currencies,
    },
  };
}
export function validateState(data: Record<string, Row[]>, settings: Row) {
  const unique = (kind: string, key: (r: Row) => string) => {
    const seen = new Set<string>();
    for (const r of data[kind]) {
      const v = key(r);
      if (seen.has(v)) throw new RuleError(`${SCHEMA[kind].label}存在重复编号：${v}`);
      seen.add(v);
    }
    return seen;
  };
  const skus = unique('skus', (r) => r.sku),
    exportMap = Object.fromEntries(
      data.exports.map((r) => [`${r.declaration_no}-${r.item_no}`, r]),
    );
  unique('exports', (r) => `${r.declaration_no}-${r.item_no}`);
  unique('receipts', (r) => r.settlement_id);
  unique('documents', (r) => r.declaration_no);
  const receipts = Object.fromEntries(data.receipts.map((r) => [r.settlement_id, r])),
    declarations = new Set(data.exports.map((r) => r.declaration_no));
  for (const e of data.exports)
    if (!skus.has(e.sku)) throw new RuleError(`请先建立 SKU 档案：${e.sku}`);
  for (const kind of ['sales', 'taxes', 'exceptions'])
    for (const r of data[kind]) {
      const e = Object.hasOwn(exportMap, r.ledger_id) ? exportMap[r.ledger_id] : undefined;
      if (!e) throw new RuleError(`${SCHEMA[kind].label}引用的核销编号不存在：${r.ledger_id}`);
      if (kind === 'sales') {
        if (r.sku !== e.sku) throw new RuleError('销售 SKU 与报关 SKU 不符');
        const p = Object.hasOwn(receipts, r.settlement_id) ? receipts[r.settlement_id] : undefined;
        if (p && p.currency !== e.currency)
          throw new RuleError('同一结算报告与所属报关单的币种必须一致');
        if (r.site && e.site && r.site !== e.site) throw new RuleError('销售站点与报关站点不符');
        if (p?.site && e.site && p.site !== e.site)
          throw new RuleError('结算报告站点与报关站点不符');
      }
    }
  for (const r of data.documents)
    if (!declarations.has(r.declaration_no)) throw new RuleError('单证留存引用的报关单不存在');
  const computed = compute(data, settings);
  for (const r of computed.ledger) {
    if (r.remaining < 0) throw new RuleError(`${r.ledger_id} 库存不足，超分配 ${-r.remaining} 件`);
    if (r.net_sold < 0) throw new RuleError(`${r.ledger_id} 累计退货超过累计销量`);
  }
  return computed;
}

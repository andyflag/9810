import * as XLSX from 'xlsx';
import { SCHEMA, ORDER, RuleError, clean, compute, DEFAULT_SETTINGS, type Row } from './domain';
const MAX = 10 * 1024 * 1024;
function checkZip(bytes: Uint8Array) {
  if (bytes.length > MAX) throw new RuleError('Excel 文件不得超过 10 MB');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new RuleError('无法读取文件，请上传有效的 .xlsx 工作簿');
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true),
    expanded = 0;
  if (count > 1000) throw new RuleError('Excel 文件结构过大');
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50)
      throw new RuleError('Excel ZIP 结构无效');
    expanded += view.getUint32(offset + 24, true);
    if (expanded > 40 * 1024 * 1024) throw new RuleError('Excel 解压后过大');
    offset +=
      46 +
      view.getUint16(offset + 28, true) +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
  }
}
export function parseWorkbook(bytes: Uint8Array) {
  let book: XLSX.WorkBook;
  try {
    checkZip(bytes);
    book = XLSX.read(bytes, { type: 'array', cellDates: false, cellFormula: true });
  } catch (e) {
    if (e instanceof RuleError) throw e;
    throw new RuleError('无法读取文件，请上传有效的 .xlsx 工作簿');
  }
  const result: Record<string, Row[]> = Object.fromEntries(ORDER.map((k) => [k, []]));
  let recognized = 0,
    count = 0;
  const errors: string[] = [];
  for (const kind of ORDER) {
    const spec = SCHEMA[kind],
      sheet = book.Sheets[spec.sheet];
    if (!sheet) continue;
    recognized++;
    const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
    if (range.e.r >= 20000 || range.e.c >= 100) throw new RuleError('工作表超出模板行列范围');
    const norm = (s: any) =>
      String(s ?? '')
        .replace('（自动）', '')
        .trim();
    for (const f of spec.fields)
      if (
        f.required &&
        norm(sheet[XLSX.utils.encode_cell({ r: spec.header_row - 1, c: f.column - 1 })]?.v) !==
          norm(f.label)
      )
        throw new RuleError(`${spec.sheet} 表头不匹配：${f.label}`);
    for (let i = spec.header_row; i <= range.e.r; i++) {
      const payload: Row = {};
      for (const f of spec.fields) {
        const cell = sheet[XLSX.utils.encode_cell({ r: i, c: f.column - 1 })];
        if (f.computed || !cell || cell.v === null || cell.v === undefined) continue;
        if (cell.f) throw new RuleError(`${spec.sheet} 第 ${i + 1} 行：手填列不能包含公式`);
        let value: any = cell.v;
        if (f.type === 'date' && typeof value === 'number') {
          const d = XLSX.SSF.parse_date_code(value, { date1904: book.Workbook?.WBProps?.date1904 });
          if (!d) throw new RuleError('日期单元格格式错误');
          value = `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
        }
        if (f.type === 'text') {
          if (
            typeof value === 'number' &&
            ['declaration_no', 'sku', 'invoice_no', 'settlement_id'].includes(f.key) &&
            String(Math.trunc(value)).length > 15
          )
            throw new RuleError(
              `${spec.sheet} 第 ${i + 1} 行：长编号必须保存为文本，避免 Excel 精度丢失`,
            );
          value = String(value);
        }
        payload[f.key] = value;
      }
      if (!Object.keys(payload).length || (kind === 'skus' && !payload.sku && !payload.name))
        continue;
      try {
        result[kind].push(clean(kind, payload));
      } catch (e) {
        errors.push(`${spec.sheet} 第 ${i + 1} 行：${(e as Error).message}`);
      }
      if (++count > 10000) throw new RuleError('每次导入最多 10,000 条记录');
    }
  }
  if (!recognized) throw new RuleError('未找到原模板工作表，请下载模板后填写');
  if (errors.length) throw new RuleError(errors.slice(0, 20).join('\n'));
  return result;
}
export function fingerprint(kind: string, row: Row) {
  const data = clean(kind, row);
  return JSON.stringify(data, Object.keys(data).sort());
}
export function mergeRecords(current: Record<string, Row[]>, incoming: Record<string, Row[]>) {
  const combined = structuredClone(current),
    added: [string, Row][] = [],
    counts: Row = Object.fromEntries(ORDER.map((k) => [k, 0]));
  let skipped = 0;
  for (const k of ORDER) {
    const seen = new Set(current[k].map((r) => fingerprint(k, r)));
    for (const row of incoming[k]) {
      const key = fingerprint(k, row);
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);
      const r = { ...row, id: crypto.randomUUID(), version: 1 };
      combined[k].push(r);
      added.push([k, r]);
      counts[k]++;
    }
  }
  return { combined, added, counts, skipped };
}
export function exportWorkbook(data: Record<string, Row[]>, settings: Row) {
  const book = XLSX.utils.book_new(),
    computed = compute(data, settings);
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ['9810 出口海外仓核销台账 · 云端导出'],
      ['导出为当前核算快照；重新导入时忽略自动列，由服务端重算。'],
      ['企业基本信息在应用设置中维护。所有编号按文本保存。'],
    ]),
    '使用说明',
  );
  const mapping = [
    ['核销编号', 'ledger_id'],
    ['SKU', 'sku'],
    ['品名', 'name'],
    ['出口日期', 'export_date'],
    ['报关数量', 'quantity'],
    ['签收数量', 'received_qty'],
    ['入仓差异', 'warehouse_difference'],
    ['累计净售出', 'net_sold'],
    ['异常减少', 'exception_qty'],
    ['在仓未售', 'remaining'],
    ['销售进度（%）', 'progress'],
    ['累计净回款（原币）', 'net_revenue'],
    ['其中已收汇（原币）', 'received_amount'],
    ['收汇截止日', 'receipt_deadline'],
    ['收汇状态', 'receipt_status'],
    ['已申报退税额（元）', 'declared_tax'],
    ['其中预退税额（元）', 'prepaid_tax'],
    ['核算期末', 'tax_deadline'],
    ['核算状态', 'tax_status'],
    ['单证情况', 'document_status'],
    ['需要关注', 'attention'],
    ['币种', 'currency'],
  ];
  const summary: any[][] = [
    ['核销总表'],
    ['自动汇总所有业务台账'],
    ['报关项数', computed.stats.export_count, '报关数量', computed.stats.quantity],
    [],
    [],
    mapping.map(([a]) => a),
  ];
  for (const r of computed.ledger) {
    r.attention = r.alerts.map((a: Row) => a.text).join('、') || '正常';
    summary.push(mapping.map(([, key]) => r[key] ?? null));
  }
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(summary), '核销总表');
  for (const k of ORDER) {
    const spec = SCHEMA[k],
      rows: any[][] = Array.from({ length: spec.header_row }, () => []);
    rows[0] = [spec.label];
    rows[1] = [spec.description];
    rows[spec.header_row - 1] = spec.fields.map(
      (f: Row) => f.label + (f.computed ? '（自动）' : ''),
    );
    if (k === 'skus') {
      for (const [key, label, row] of [
        ['company_name', '企业名称', 5],
        ['company_type', '企业类型', 6],
        ['shop_name', '亚马逊店铺名称', 7],
        ['tax_authority', '主管税务机关', 8],
        ['filing_date', '出口退（免）税备案日期', 9],
      ] as [string, string, number][])
        rows[row - 1] = [label, settings[key] || ''];
    }
    for (const r of computed.records[k])
      rows.push(
        spec.fields.map((f: Row) =>
          r[f.key] === null || r[f.key] === undefined
            ? null
            : ['number', 'integer'].includes(f.type)
              ? Number(r[f.key])
              : String(r[f.key]),
        ),
      );
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet['!cols'] = spec.fields.map((f: Row) => ({ wch: f.column === 1 ? 30 : 23 }));
    sheet['!autofilter'] = {
      ref: `A${spec.header_row}:${XLSX.utils.encode_cell({ r: Math.max(spec.header_row, rows.length) - 1, c: spec.fields.length - 1 })}`,
    };
    XLSX.utils.book_append_sheet(book, sheet, spec.sheet);
  }
  // aoa_to_sheet marks every string as type s, including leading '=' text.
  return new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx', compression: true }));
}

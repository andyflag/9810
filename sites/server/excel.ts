import * as XLSX from 'xlsx';
import { Inflate } from 'fflate';
import { SCHEMA, ORDER, RuleError, clean, compute, D, type Row } from './domain';
const MAX = 10 * 1024 * 1024;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function verifyEntry(
  bytes: Uint8Array,
  offset: number,
  compressed: number,
  size: number,
  method: number,
  checksum: number,
) {
  let expanded = 0,
    crc = 0xffffffff,
    complete = false;
  const accept = (chunk: Uint8Array, final: boolean) => {
    expanded += chunk.length;
    if (expanded > size || expanded > 40 * 1024 * 1024)
      throw new RuleError('Excel 解压大小与文件声明不一致');
    for (const value of chunk) crc = CRC_TABLE[(crc ^ value) & 255] ^ (crc >>> 8);
    complete ||= final;
  };
  if (method === 8) {
    // Small compressed chunks keep any one output chunk bounded even when the
    // advertised uncompressed size and CRC were both forged by an input file.
    const inflater = new Inflate(accept);
    if (!compressed) inflater.push(new Uint8Array(), true);
    for (let i = 0; i < compressed; i += 1024)
      inflater.push(
        bytes.subarray(offset + i, offset + Math.min(i + 1024, compressed)),
        i + 1024 >= compressed,
      );
  } else {
    accept(bytes.subarray(offset, offset + compressed), true);
  }
  if (!complete || expanded !== size || (crc ^ 0xffffffff) >>> 0 !== checksum)
    throw new RuleError('Excel ZIP 内容校验失败，请重新另存为 .xlsx 后导入');
}
function checkZip(bytes: Uint8Array): Uint8Array {
  if (bytes.length > MAX) throw new RuleError('Excel 文件不得超过 10 MB');
  const invalid = () => new RuleError('Excel ZIP 结构无效，请重新另存为 .xlsx 后导入');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === bytes.length
    ) {
      end = i;
      break;
    }
  if (end < 0) throw invalid();
  const count = view.getUint16(end + 10, true);
  const start = view.getUint32(end + 16, true),
    directorySize = view.getUint32(end + 12, true);
  // SheetJS reads the per-disk count, so both counts and the complete directory
  // must agree before the decompressor can allocate any entry buffers.
  if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    view.getUint16(end + 8, true) !== count ||
    !count ||
    start + directorySize !== end
  )
    throw invalid();
  if (count > 1000) throw new RuleError('Excel 文件结构过大');
  const checkExtra = (offset: number, length: number, limit: number) => {
    const stop = offset + length;
    if (stop > limit) throw invalid();
    while (offset < stop) {
      if (offset + 4 > stop) throw invalid();
      const tag = view.getUint16(offset, true),
        size = view.getUint16(offset + 2, true);
      if (tag === 1) throw new RuleError('暂不支持 ZIP64 工作簿，请重新另存为 .xlsx 后导入');
      offset += 4 + size;
      if (offset > stop) throw invalid();
    }
  };
  let offset = start,
    expanded = 0,
    normalized: Uint8Array | undefined;
  const ranges: [number, number][] = [],
    names = new Set<string>();
  const entries: [number, number, number, number, number][] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw invalid();
    const flags = view.getUint16(offset + 8, true),
      method = view.getUint16(offset + 10, true);
    const checksum = view.getUint32(offset + 16, true),
      compressed = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true),
      nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true),
      commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true),
      next = offset + 46 + nameLength + extraLength + commentLength;
    if (
      next > end ||
      !nameLength ||
      view.getUint16(offset + 34, true) ||
      flags & 0x2041 ||
      ![0, 8].includes(method) ||
      (method === 0 && compressed !== size)
    )
      throw invalid();
    expanded += size;
    if (expanded > 40 * 1024 * 1024) throw new RuleError('Excel 解压后过大');
    checkExtra(offset + 46 + nameLength, extraLength, next);
    if (
      local + 30 > start ||
      view.getUint32(local, true) !== 0x04034b50 ||
      view.getUint16(local + 6, true) !== flags ||
      view.getUint16(local + 8, true) !== method ||
      view.getUint16(local + 26, true) !== nameLength
    )
      throw invalid();
    const localExtra = view.getUint16(local + 28, true),
      dataStart = local + 30 + nameLength + localExtra;
    const dataEnd = dataStart + compressed;
    if (dataEnd > start) throw invalid();
    checkExtra(local + 30 + nameLength, localExtra, dataStart);
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    if (nameBytes.some((value, j) => value !== bytes[local + 30 + j])) throw invalid();
    const nameKey = Array.from(nameBytes).join(',');
    if (names.has(nameKey)) throw invalid();
    names.add(nameKey);
    const localChecksum = view.getUint32(local + 14, true);
    const localCompressed = view.getUint32(local + 18, true),
      localSize = view.getUint32(local + 22, true);
    let entryEnd = dataEnd;
    if (flags & 8) {
      if (
        (localChecksum && localChecksum !== checksum) ||
        (localCompressed && localCompressed !== compressed) ||
        (localSize && localSize !== size) ||
        dataEnd + 12 > start
      )
        throw invalid();
      const descriptor = dataEnd + (view.getUint32(dataEnd, true) === 0x08074b50 ? 4 : 0);
      if (
        descriptor + 12 > start ||
        view.getUint32(descriptor, true) !== checksum ||
        view.getUint32(descriptor + 4, true) !== compressed ||
        view.getUint32(descriptor + 8, true) !== size
      )
        throw invalid();
      entryEnd = descriptor + 12;
      // Streaming ZIPs legitimately omit local sizes. Normalize them from the
      // verified directory so SheetJS uses a bounded buffer rather than growth.
      normalized ??= bytes.slice();
      const normalizedView = new DataView(normalized.buffer);
      normalizedView.setUint32(local + 18, compressed, true);
      normalizedView.setUint32(local + 22, size, true);
    } else if (localChecksum !== checksum || localCompressed !== compressed || localSize !== size)
      throw invalid();
    ranges.push([local, entryEnd]);
    entries.push([dataStart, compressed, size, method, checksum]);
    offset = next;
  }
  if (offset !== end) throw invalid();
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) throw invalid();
  for (const entry of entries) verifyEntry(bytes, ...entry);
  return normalized || bytes;
}
export function parseWorkbook(bytes: Uint8Array) {
  let book: XLSX.WorkBook;
  try {
    const verified = checkZip(bytes);
    book = XLSX.read(verified, { type: 'array', cellDates: false, cellFormula: true });
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
    let lastHeader = 0;
    for (let column = 0; column <= range.e.c; column++)
      if (norm(sheet[XLSX.utils.encode_cell({ r: spec.header_row - 1, c: column })]?.v))
        lastHeader = column + 1;
    const absentColumns = new Set<string>();
    for (const f of spec.fields) {
      if (f.computed) continue;
      const header = norm(
        sheet[XLSX.utils.encode_cell({ r: spec.header_row - 1, c: f.column - 1 })]?.v,
      );
      if (header === norm(f.label)) continue;
      // The original template may lack optional columns appended by the app.
      if (!f.required && !header && f.column > lastHeader) absentColumns.add(f.key);
      else throw new RuleError(`${spec.sheet} 表头不匹配：${f.label}`);
    }
    for (let i = spec.header_row; i <= range.e.r; i++) {
      const payload: Row = {};
      for (const f of spec.fields) {
        const cell = sheet[XLSX.utils.encode_cell({ r: i, c: f.column - 1 })];
        if (f.computed || !cell) continue;
        if (cell.f) throw new RuleError(`${spec.sheet} 第 ${i + 1} 行：手填列不能包含公式`);
        if (cell.v === null || cell.v === undefined) continue;
        if (absentColumns.has(f.key)) throw new RuleError(`${spec.sheet} 表头不匹配：${f.label}`);
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
              ? D(r[f.key]).precision() > 15
                ? D(r[f.key]).toFixed()
                : Number(r[f.key])
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

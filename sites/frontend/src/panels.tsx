import React, { useState, useEffect, useRef } from 'react';
import {
  Plus,
  Upload,
  ArrowRight,
  ArrowDownToLine,
  CheckCircle2,
  AlertCircle,
  Info,
  Trash2,
  Paperclip,
  Loader2,
  FileSpreadsheet,
  Copy,
  Users,
  ShieldCheck,
  Save,
  Layers3,
} from 'lucide-react';
import { Modal, Badge } from './main';
import { api, labels, roles, display, num, cnToday, downloadUrl } from './types';
import type { State, Kind, Row, Field } from './types';
type Changed = (message?: string) => Promise<void>;
const defaultValues: Partial<Record<Kind, Row>> = {
  exports: {
    trade_mode: '9810',
    item_no: 1,
    currency: 'USD',
    site: '美国US',
    exchange_rate: '7.1',
  },
  sales: { returned_qty: 0, fees: 0, site: '美国US' },
  receipts: { currency: 'USD', site: '美国US' },
  taxes: { method: '未售-海外仓预退（HWC-YT）' },
  skus: { unit: '个', tax_rate: '0.13' },
  exceptions: { tax_adjustment: '待处理' },
  documents: { storage_type: '数字化' },
};
function useDraftClose(dirty: boolean, busy: boolean, onClose: () => void) {
  useEffect(() => {
    if (!dirty) return;
    const handle = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handle);
    return () => window.removeEventListener('beforeunload', handle);
  }, [dirty]);
  return () => {
    if (busy) return;
    if (!dirty || window.confirm('还有未保存的修改，确定关闭并放弃修改？')) onClose();
  };
}
function ErrorBox({ message }: { message: string }) {
  return message ? (
    <div className="error" role="alert">
      <AlertCircle size={17} />
      <span>{message}</span>
    </div>
  ) : null;
}
function Busy({ busy }: { busy: boolean }) {
  return busy ? <Loader2 size={16} className="spin" /> : null;
}
export function RecordEditor({
  state,
  kind,
  row,
  defaults,
  onClose,
  onChanged,
}: {
  state: State;
  kind: Kind;
  row?: Row;
  defaults?: Row;
  onClose: () => void;
  onChanged: Changed;
}) {
  const [values, setValues] = useState<Row>({ ...defaultValues[kind], ...defaults, ...row }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirmDelete, setConfirmDelete] = useState(false);
  const editable = state.user.role !== 'viewer',
    spec = state.schema[kind];
  const originalValues = useRef(values);
  const dirty =
    editable &&
    spec.fields
      .filter((f) => !f.computed)
      .some((f) => String(values[f.key] ?? '') !== String(originalValues.current[f.key] ?? ''));
  const close = useDraftClose(dirty, busy, onClose);
  const update = (key: string, value: any) => {
    setValues((v) => ({ ...v, [key]: value }));
    setError('');
  };
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/records/' + kind + (row ? '/' + row.id : ''), row ? 'PUT' : 'POST', {
        data: values,
        version: row?.version,
      });
      await onChanged();
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError('');
    try {
      await api(`/records/${kind}/${row!.id}?version=${row!.version}`, 'DELETE');
      await onChanged('记录已删除');
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function upload(file: File) {
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      await api(`/documents/${row!.id}/files`, 'POST', form);
      await onChanged('单证附件已保存');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function deleteFile(id: string) {
    setBusy(true);
    try {
      await api('/files/' + id, 'DELETE');
      await onChanged('附件已删除');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function input(f: Field) {
    const props = {
      id: 'field-' + f.key,
      value: values[f.key] ?? '',
      required: f.required,
      disabled: !editable || busy,
      onChange: (
        e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
      ) => update(f.key, e.target.value),
    };
    let options = f.options;
    if (f.key === 'sku' && kind !== 'skus') options = state.records.skus.map((r) => r.sku);
    if (f.key === 'ledger_id') options = state.records.exports.map((r) => r.ledger_id);
    if (f.key === 'declaration_no' && kind === 'documents')
      options = [...new Set(state.records.exports.map((r) => r.declaration_no))];
    if (options)
      return (
        <select {...props}>
          <option value="">请选择{f.label}</option>
          {options.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      );
    if (f.key === 'notes' || f.key === 'discrepancy_notes')
      return <textarea {...props} rows={3} placeholder="补充说明（可选）" />;
    return (
      <input
        {...props}
        type={
          f.type === 'date'
            ? 'date'
            : f.type === 'number' || f.type === 'integer'
              ? 'number'
              : 'text'
        }
        step={f.type === 'integer' ? '1' : 'any'}
        placeholder={
          f.key === 'settlement_id'
            ? '与结算报告编号保持一致'
            : f.key === 'declaration_no'
              ? '完整报关单号（按文本保存）'
              : '请输入' + f.label
        }
        maxLength={2000}
        list={f.key === 'settlement_id' && kind === 'sales' ? 'settlements' : undefined}
      />
    );
  }
  return (
    <Modal
      title={(editable ? (row ? '编辑' : '新增') : '查看') + labels[kind]}
      subtitle={row ? '记录关联数据将在保存后重新核算' : '白色字段手动填写，关联信息由系统计算'}
      wide
      busy={busy}
      onClose={close}
    >
      <form onSubmit={save}>
        <div className="form-body">
          <div className="inline-info">
            <Info size={16} />
            <span>
              {kind === 'exports' && !state.records.skus.length
                ? '请先在左侧「SKU 档案」建立商品，再登记出口报关。'
                : '带 * 的字段为必填项。核销编号、金额与状态由服务端统一计算。'}
            </span>
          </div>
          <datalist id="settlements">
            {state.records.receipts.map((r) => (
              <option key={r.id} value={r.settlement_id} />
            ))}
          </datalist>
          <div className="form-grid">
            {spec.fields
              .filter((f) => !f.computed)
              .map((f) => (
                <label
                  key={f.key}
                  className={f.key === 'notes' || f.key === 'discrepancy_notes' ? 'full-width' : ''}
                  htmlFor={'field-' + f.key}
                >
                  <span>
                    {f.label}
                    {f.required && <em> *</em>}
                  </span>
                  {input(f)}
                  {f.hint && <small>{f.hint}</small>}
                </label>
              ))}
          </div>
          {row && spec.fields.some((f) => f.computed) && (
            <details className="computed-details">
              <summary>查看当前自动核算字段</summary>
              <div className="computed-grid">
                {spec.fields
                  .filter((f) => f.computed)
                  .map((f) => (
                    <div key={f.key}>
                      <small>{f.label}</small>
                      <strong>{display(row[f.key], f)}</strong>
                    </div>
                  ))}
              </div>
            </details>
          )}
          {kind === 'documents' && (
            <div className="attachment-section">
              <h3>
                <Paperclip size={17} />
                单证附件
              </h3>
              {!row ? (
                <p className="muted">保存记录后，可上传合同、运输单据和银行水单。</p>
              ) : (
                <>
                  <p className="muted">
                    单个文件最大 10 MB，企业总容量 100 MB。下载需登录所属企业。
                  </p>
                  <div className="attachment-list">
                    {state.files
                      .filter((f) => f.record_id === row.id)
                      .map((f) => (
                        <div key={f.id}>
                          <a href={downloadUrl('/files/' + f.id, state.user.tenant_id)}>
                            <Paperclip size={15} />
                            {f.name}
                            <small>{num(f.size / 1024)} KB</small>
                          </a>
                          {editable && (
                            <button
                              type="button"
                              className="icon-button danger-text"
                              disabled={busy}
                              onClick={() => {
                                if (window.confirm('确定删除附件「' + f.name + '」？'))
                                  deleteFile(f.id);
                              }}
                              aria-label={'删除附件' + f.name}
                            >
                              <Trash2 size={15} />
                            </button>
                          )}
                        </div>
                      ))}
                  </div>
                  {editable && (
                    <label className="upload-attachment button">
                      <Plus size={16} />
                      上传单证
                      <input
                        type="file"
                        disabled={busy}
                        accept=".pdf,.png,.jpg,.jpeg,.xlsx,.docx,.txt,.csv"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) upload(file);
                          e.target.value = '';
                        }}
                      />
                    </label>
                  )}
                </>
              )}
            </div>
          )}
          <ErrorBox message={error} />
          {confirmDelete && (
            <div className="delete-confirm">
              <AlertCircle size={17} />
              <div>
                <strong>确定删除这条记录？</strong>
                <p>关联单证附件也会删除；被其他台账引用的记录需先解除关联。</p>
                <button type="button" onClick={() => setConfirmDelete(false)}>
                  取消
                </button>
                <button type="button" className="danger-button" disabled={busy} onClick={remove}>
                  确认删除
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          {editable && row && (
            <button
              type="button"
              className="danger-text bare"
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
            >
              <Trash2 size={16} />
              删除记录
            </button>
          )}
          <div className="spacer" />
          <button type="button" disabled={busy} onClick={close}>
            {editable ? '取消' : '关闭'}
          </button>
          {editable && (
            <button className="primary" type="submit" disabled={busy}>
              <Busy busy={busy} />
              <Save size={16} />
              保存记录
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
export function ImportDialog({
  state,
  onClose,
  onChanged,
}: {
  state: State;
  onClose: () => void;
  onChanged: Changed;
}) {
  const [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState<Row | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function run(dry = true) {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const f = new FormData();
      f.append('file', file);
      const r = await api('/import?dry_run=' + dry, 'POST', f);
      if (dry) setPreview(r);
      else {
        await onChanged(`已导入 ${r.total} 条记录，跳过 ${r.skipped} 条重复数据`);
        onClose();
      }
    } catch (e: any) {
      setPreview(null);
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="导入 Excel 台账"
      subtitle="兼容原始模板与本应用导出的工作簿"
      busy={busy}
      onClose={() => !busy && onClose()}
    >
      <div className="form-body">
        <div className="import-steps">
          <span className={!preview ? 'current' : ''}>1 选择文件</span>
          <ArrowRight size={14} />
          <span className={preview ? 'current' : ''}>2 校验预览</span>
          <ArrowRight size={14} />
          <span>3 确认导入</span>
        </div>
        <label className="dropzone">
          <div className="empty-icon">
            <FileSpreadsheet size={30} />
          </div>
          <strong>{file ? file.name : '点击选择 Excel 工作簿'}</strong>
          <span>支持 .xlsx，最大 10 MB</span>
          <input
            type="file"
            accept=".xlsx"
            disabled={busy}
            onChange={(e) => {
              setFile(e.target.files?.[0] || null);
              setPreview(null);
              setError('');
            }}
          />
        </label>
        <a href={downloadUrl('/template', state.user.tenant_id)} className="download-template">
          <ArrowDownToLine size={15} />
          下载原始台账模板（含示例）
        </a>
        <div className="inline-info">
          <Info size={16} />
          <span>
            仅追加新记录，完全一致的行会跳过。相同编号但内容不同将提示冲突，请在台账中编辑。企业基本信息请在设置页维护。
          </span>
        </div>
        {preview && (
          <div className="import-preview">
            <h3>
              <CheckCircle2 size={19} />
              校验通过
            </h3>
            <div className="import-counts">
              {Object.entries(preview.counts).map(([k, v]) => (
                <div key={k}>
                  <span>{state.schema[k as Kind].label}</span>
                  <strong>{String(v)} 条</strong>
                </div>
              ))}
            </div>
            <p>
              将新增 <strong>{preview.total}</strong> 条 · 跳过重复{' '}
              <strong>{preview.skipped}</strong> 条
            </p>
            {preview.examples > 0 && (
              <div className="sample-note">
                其中 {preview.examples} 条标记为「示例」，确认后会作为示例记录导入。
              </div>
            )}
          </div>
        )}
        <ErrorBox message={error} />
      </div>
      <div className="modal-footer">
        <button disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          className="primary"
          disabled={!file || busy || (!!preview && preview.total === 0)}
          onClick={() => run(!preview)}
        >
          <Busy busy={busy} />
          {preview ? '确认导入' : '校验并预览'}
          <ArrowRight size={16} />
        </button>
      </div>
    </Modal>
  );
}
export function FifoDialog({
  state,
  onClose,
  onChanged,
}: {
  state: State;
  onClose: () => void;
  onChanged: Changed;
}) {
  const [values, setValues] = useState<Row>({
      sku: '',
      settlement_id: '',
      month: cnToday().slice(0, 7),
      quantity: '',
      gross: '',
      fees: '0',
      sale_date: cnToday(),
      evidence_date: '',
    }),
    [preview, setPreview] = useState<Row | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const originalValues = useRef(values);
  const dirty = Object.keys(values).some(
    (key) => String(values[key] ?? '') !== String(originalValues.current[key] ?? ''),
  );
  const close = useDraftClose(dirty, busy, onClose);
  function change(key: string, value: string) {
    setValues({ ...values, [key]: value });
    setPreview(null);
  }
  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api('/sales/fifo', 'POST', {
        ...values,
        quantity: Number(values.quantity),
        month: values.month + '-01',
        sale_date: values.sale_date || null,
        evidence_date: values.evidence_date || null,
        commit: !!preview,
        revision: preview?.revision,
      });
      if (preview) {
        await onChanged(`已生成 ${r.rows.length} 条销售核销记录`);
        onClose();
      } else setPreview(r);
    } catch (e: any) {
      setError(e.message);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="FIFO 销量分配"
      subtitle="按出口日期，从最早的可用库存开始分配"
      busy={busy}
      wide
      onClose={close}
    >
      <form onSubmit={run}>
        <div className="form-body">
          <div className="inline-info">
            <Layers3 size={16} />
            <span>
              自动匹配结算报告的站点与币种，销售额和扣费按数量比例分配，尾差归入最后一票。退货请单独登记销售核销。
            </span>
          </div>
          <div className="form-grid">
            <label>
              SKU *
              <select
                disabled={busy}
                required
                value={values.sku}
                onChange={(e) => change('sku', e.target.value)}
              >
                <option value="">选择商品</option>
                {state.records.skus.map((r) => (
                  <option key={r.sku}>{r.sku}</option>
                ))}
              </select>
            </label>
            <label>
              结算报告 *
              <select
                disabled={busy}
                required
                value={values.settlement_id}
                onChange={(e) => change('settlement_id', e.target.value)}
              >
                <option value="">选择已登记的结算报告</option>
                {state.records.receipts.map((r) => (
                  <option key={r.id}>{r.settlement_id}</option>
                ))}
              </select>
            </label>
            {[
              ['month', '销售月份', 'month'],
              ['quantity', '售出数量', 'number'],
              ['gross', '商品销售额（原币）', 'number'],
              ['fees', '平台扣费（原币）', 'number'],
              ['sale_date', '实现销售日期', 'date'],
              ['evidence_date', '销售佐证留存日期', 'date'],
            ].map(([k, l, t]) => (
              <label key={k}>
                {l}
                {k !== 'evidence_date' ? ' *' : ''}
                <input
                  disabled={busy}
                  type={t}
                  step={k === 'quantity' ? '1' : 'any'}
                  min={k === 'quantity' ? 1 : undefined}
                  required={k !== 'evidence_date'}
                  value={values[k]}
                  onChange={(e) => change(k, e.target.value)}
                />
              </label>
            ))}
          </div>
          {preview && (
            <div className="fifo-preview">
              <h3>分配预览 · {preview.rows.length} 票</h3>
              <table>
                <thead>
                  <tr>
                    <th>核销编号</th>
                    <th>数量</th>
                    <th>销售额</th>
                    <th>扣费</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r: Row) => (
                    <tr key={r.ledger_id}>
                      <td>{r.ledger_id}</td>
                      <td>{num(r.sold_qty)}</td>
                      <td>{num(r.gross)}</td>
                      <td>{num(r.fees)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <ErrorBox message={error} />
        </div>
        <div className="modal-footer">
          <button type="button" onClick={close} disabled={busy}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            <Busy busy={busy} />
            {preview ? '确认生成销售记录' : '预览分配'}
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function SettingsPanel({
  state,
  onChanged,
  onDirtyChange,
  onBusyChange,
}: {
  state: State;
  onChanged: Changed;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [values, setValues] = useState({ ...state.settings }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    setValues({ ...state.settings });
  }, [state.settings]);
  const dirty = Object.keys(state.settings).some(
    (key) => String(values[key] ?? '') !== String(state.settings[key] ?? ''),
  );
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/settings', 'PUT', { data: values, version: state.revision });
      await onChanged('企业参数已更新');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  const groups = [
    {
      title: '企业基本信息',
      text: '用于区分企业空间与确定退税计税依据。',
      fields: [
        ['company_name', '企业名称', 'text'],
        ['company_type', '企业类型', 'select'],
        ['shop_name', '亚马逊店铺名称', 'text'],
        ['tax_authority', '主管税务机关', 'text'],
        ['filing_date', '出口退（免）税备案日期', 'date'],
      ],
    },
    {
      title: '期限与提醒规则',
      text: '默认期限来自上传的台账模板。生产企业可在每条退税记录中单独调整核算截止日。',
      fields: [
        ['warning_days', '核算预警天数', 'number'],
        ['evidence_days', '销售佐证 / 单证留存天数', 'number'],
        ['retention_years', '单证保存年限', 'number'],
        ['deadline_month', '次年截止月份', 'number'],
        ['deadline_day', '次年截止日期（日）', 'number'],
      ],
    },
  ];
  return (
    <form className="settings-form" onSubmit={save}>
      {groups.map((g) => (
        <section className="panel settings-section" key={g.title}>
          <div>
            <h2>{g.title}</h2>
            <p>{g.text}</p>
          </div>
          <div className="form-grid">
            {g.fields.map(([k, l, t]) => (
              <label key={k}>
                {l}
                {t === 'select' ? (
                  <select
                    disabled={busy}
                    value={values[k]}
                    onChange={(e) => setValues({ ...values, [k]: e.target.value })}
                  >
                    <option>外贸企业</option>
                    <option>生产企业</option>
                  </select>
                ) : (
                  <input
                    disabled={busy}
                    type={t}
                    required={k === 'company_name' || t === 'number'}
                    min={t === 'number' ? 1 : undefined}
                    value={values[k] ?? ''}
                    onChange={(e) =>
                      setValues({
                        ...values,
                        [k]: t === 'number' ? e.target.valueAsNumber : e.target.value,
                      })
                    }
                  />
                )}
              </label>
            ))}
          </div>
        </section>
      ))}
      <div className="inline-info">
        <Info size={16} />
        <span>
          外贸企业按进项发票不含税金额 × 退税率估算，生产企业按 FOB 人民币金额 ×
          退税率估算。申报与核算以实际业务及主管部门要求为准。
        </span>
      </div>
      <ErrorBox message={error} />
      <div className="settings-save">
        <button className="primary" disabled={busy}>
          <Busy busy={busy} />
          <Save size={16} />
          保存企业设置
        </button>
      </div>
    </form>
  );
}
export function TeamPanel({ state, onChanged }: { state: State; onChanged: Changed }) {
  const [members, setMembers] = useState<Row[]>([]),
    [email, setEmail] = useState(''),
    [role, setRole] = useState('editor'),
    [link, setLink] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [copied, setCopied] = useState(false),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setMembers([]);
    api<Row[]>('/team', 'GET', undefined, {
      workspaceId: state.user.tenant_id,
      signal: controller.signal,
    })
      .then((rows) => {
        if (!controller.signal.aborted) setMembers(rows);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [state.revision, state.user.tenant_id]);
  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setLink('');
    try {
      const r = await api('/invitations', 'POST', { email, role });
      setLink(location.origin + '/?invite=' + encodeURIComponent(r.token));
      setCopied(false);
      await onChanged('邀请链接已生成');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(r: Row) {
    if (!window.confirm('确定移除成员 ' + r.name + '？其当前企业会话会失效。')) return;
    setBusy(true);
    try {
      await api('/team/' + r.id, 'DELETE');
      await onChanged('成员已移除');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="team-grid">
      <section className="panel">
        <div className="panel-heading">
          <h2>
            企业成员<span className="count-tag">{members.length}</span>
          </h2>
          <Users size={19} />
        </div>
        <div className="members-list" aria-busy={loading}>
          {loading && (
            <div className="empty-state compact">
              <Loader2 className="spin" aria-label="正在读取成员" />
            </div>
          )}
          {members.map((r) => (
            <div key={r.id} className="member-row">
              <span className="avatar">{r.name.slice(0, 1)}</span>
              <div>
                <strong>
                  {r.name}
                  {r.id === state.user.id && <span className="you-tag">你</span>}
                </strong>
                <p>{r.email}</p>
              </div>
              <span className="badge neutral">{roles[r.role]}</span>
              {r.role !== 'owner' && (
                <button
                  className="icon-button danger-text"
                  disabled={busy}
                  onClick={() => remove(r)}
                  aria-label={'移除' + r.name}
                >
                  <Trash2 size={15} />
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
      <section className="panel invite-panel">
        <div className="panel-heading">
          <h2>邀请同事加入</h2>
          <Plus size={20} />
        </div>
        <form onSubmit={invite}>
          <label>
            受邀邮箱
            <input
              disabled={busy}
              type="email"
              required
              placeholder="colleague@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            访问权限
            <select disabled={busy} value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="editor">编辑成员 · 管理业务台账</option>
              <option value="viewer">只读成员 · 查看与导出</option>
            </select>
          </label>
          <p className="muted">
            邀请 7 天内有效，仅指定邮箱可接受。若站点仍为私有，请先在 Sites
            共享设置中允许同事访问，再分享此企业邀请链接。
          </p>
          <button className="primary" disabled={busy}>
            <Busy busy={busy} />
            生成邀请链接
            <ArrowRight size={15} />
          </button>
        </form>
        {link && (
          <div className="invite-result">
            <label>
              邀请链接
              <input value={link} readOnly onFocus={(e) => e.target.select()} />
            </label>
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(link);
                  setCopied(true);
                } catch {
                  setError('复制不可用，请选中链接手动复制');
                }
              }}
            >
              <Copy size={15} />
              {copied ? '已复制' : '复制链接'}
            </button>
          </div>
        )}
        <ErrorBox message={error} />
      </section>
    </div>
  );
}
export function AuditPanel({ revision }: { revision: number }) {
  const [rows, setRows] = useState<Row[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setRows([]);
    api<Row[]>('/audit', 'GET', undefined, { signal: controller.signal })
      .then((rows) => {
        if (!controller.signal.aborted) setRows(rows);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision]);
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>最近操作记录</h2>
          <p>展示最近 200 条，完整历史保存在数据库中。时间统一显示为北京时间。</p>
        </div>
        <ShieldCheck size={20} />
      </div>
      <ErrorBox message={error} />
      {loading ? (
        <div className="empty-state compact">
          <Loader2 className="spin" />
        </div>
      ) : !rows.length ? (
        <div className="empty-state compact">开始操作后，变更记录会显示在这里。</div>
      ) : (
        <div className="audit-list">
          {rows.map((r) => (
            <div className="audit-row" key={r.id}>
              <span className="audit-dot" />
              <div>
                <strong>{r.action}</strong>
                <span className="muted"> · {r.name}</span>
                <p>{r.target}</p>
                {(r.before_json || r.after_json) && (
                  <details>
                    <summary>查看变更内容</summary>
                    <div className="audit-change">
                      {r.before_json && (
                        <div>
                          <small>变更前</small>
                          <pre>{JSON.stringify(JSON.parse(r.before_json), null, 2)}</pre>
                        </div>
                      )}
                      {r.after_json && (
                        <div>
                          <small>变更后</small>
                          <pre>{JSON.stringify(JSON.parse(r.after_json), null, 2)}</pre>
                        </div>
                      )}
                    </div>
                  </details>
                )}
              </div>
              <time>
                {new Date(r.created_at.replace(' ', 'T') + 'Z').toLocaleString('zh-CN', {
                  timeZone: 'Asia/Shanghai',
                })}
              </time>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export type Row = Record<string, any>;
export type Kind = 'skus' | 'exports' | 'sales' | 'receipts' | 'taxes' | 'exceptions' | 'documents';
export type Page = 'dashboard' | Kind | 'settings' | 'team' | 'audit';
export type Field = {
  key: string;
  label: string;
  type: 'text' | 'date' | 'number' | 'integer';
  computed: boolean;
  required: boolean;
  options?: string[];
  hint?: string;
};
export type State = {
  schema: Record<Kind, { label: string; description: string; fields: Field[] }>;
  records: Record<Kind, Row[]>;
  ledger: Row[];
  stats: Row;
  settings: Row;
  revision: number;
  user: { id: string; name: string; email: string; role: string; tenant_id: string };
  workspaces: { id: string; name: string; role: string }[];
  files: Row[];
};
export const kindOrder: Kind[] = [
  'exports',
  'sales',
  'receipts',
  'taxes',
  'exceptions',
  'documents',
  'skus',
];
export const labels: Record<Page, string> = {
  dashboard: '工作台',
  exports: '出口报关',
  sales: '销售核销',
  receipts: '回款收汇',
  taxes: '退税核算',
  exceptions: '库存异常',
  documents: '单证留存',
  skus: 'SKU 档案',
  settings: '企业设置',
  team: '团队成员',
  audit: '操作日志',
};
export const roles: Record<string, string> = {
  owner: '管理员',
  editor: '编辑成员',
  viewer: '只读成员',
};
const workspaceStorageKey = '9810-active-workspace';
let activeWorkspace: string | null = null;
try {
  activeWorkspace = sessionStorage.getItem(workspaceStorageKey);
} catch {}
export function getWorkspaceId() {
  return activeWorkspace;
}
export function setWorkspaceId(id: string | null) {
  activeWorkspace = id;
  try {
    if (id) sessionStorage.setItem(workspaceStorageKey, id);
    else sessionStorage.removeItem(workspaceStorageKey);
  } catch {}
}
export function downloadUrl(path: string, workspaceId = activeWorkspace) {
  const url = new URL('/api' + path, location.origin);
  if (workspaceId) url.searchParams.set('workspace_id', workspaceId);
  return url.pathname + url.search;
}
export async function api<T = any>(
  path: string,
  method = 'GET',
  body?: unknown,
  options: { workspaceId?: string | null; signal?: AbortSignal } = {},
): Promise<T> {
  const workspaceId = options.workspaceId === undefined ? activeWorkspace : options.workspaceId;
  const headers: Record<string, string> = { 'X-Requested-With': '9810' };
  if (!(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (workspaceId) headers['X-Workspace-ID'] = workspaceId;
  const response = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers,
    signal: options.signal,
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  if (!response.ok) {
    let message = '请求失败，请稍后重试';
    try {
      const result = await response.json();
      message =
        typeof result.detail === 'string'
          ? result.detail
          : result.detail?.map((x: any) => x.msg).join('；') || message;
    } catch {}
    throw Object.assign(new Error(message), { status: response.status });
  }
  return response.json();
}
export const num = (v: any) => Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
export const cash = (v: any, c = 'CNY') =>
  new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: c,
    maximumFractionDigits: 2,
  }).format(Number(v || 0));
export function tone(v: any): string {
  const s = String(v || '');
  if (
    [
      '已售部分已收汇',
      '已收汇',
      '齐全',
      '一致',
      '及时',
      '按时',
      '已核算',
      '无需冲减',
      '已留存',
    ].includes(s)
  )
    return 'success';
  return /逾期|超期|不符/.test(s)
    ? 'danger'
    : /待|未|缺|临近|中|差异|部分/.test(s)
      ? 'warning'
      : /已|齐全|一致|及时|按时|无需/.test(s)
        ? 'success'
        : 'neutral';
}
export function display(v: any, field?: Field) {
  if (v === null || v === undefined || v === '') return '—';
  if (field?.key === 'tax_rate')
    return new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 6 }).format(
      Number(v),
    );
  if (field?.key === 'exchange_rate')
    return Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 8 });
  if (field?.type === 'number' || field?.type === 'integer') return num(v);
  return String(v);
}
export function cnToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  return ['year', 'month', 'day'].map((t) => parts.find((p) => p.type === t)?.value).join('-');
}

import React, { useEffect, useState, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import {
  LayoutDashboard,
  Package,
  ArrowUpRight,
  ArrowDownToLine,
  ArrowUpFromLine,
  Plus,
  Search,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  ChevronsUpDown,
  Check,
  CheckCircle2,
  AlertCircle,
  Clock3,
  Boxes,
  Ship,
  ShoppingBag,
  Wallet,
  CircleDollarSign,
  FolderCheck,
  Settings,
  Users,
  History,
  LogOut,
  X,
  Menu,
  ArrowRight,
  RefreshCw,
  FileSpreadsheet,
  SlidersHorizontal,
  MoreHorizontal,
  Building2,
  ShieldCheck,
  Layers3,
  Loader2,
  ExternalLink,
  FileText,
  Trash2,
  Paperclip,
  Copy,
  Eye,
  Info,
} from 'lucide-react';
import {
  api,
  labels,
  roles,
  kindOrder,
  num,
  cash,
  tone,
  display,
  cnToday,
  getWorkspaceId,
  setWorkspaceId,
  downloadUrl,
} from './types';
import type { State, Row, Kind, Page, Field } from './types';
import './styles.css';
import {
  RecordEditor,
  ImportDialog,
  FifoDialog,
  SettingsPanel,
  TeamPanel,
  AuditPanel,
} from './panels';
const icons: Record<Page, any> = {
  dashboard: LayoutDashboard,
  exports: Ship,
  sales: ShoppingBag,
  receipts: Wallet,
  taxes: CircleDollarSign,
  exceptions: Boxes,
  documents: FolderCheck,
  skus: Package,
  settings: Settings,
  team: Users,
  audit: History,
};
const statusFields = new Set([
  'status',
  'receipt_status',
  'evidence_status',
  'completeness',
  'timeliness',
  'sku_check',
  'tax_adjustment',
]);
const visibleFields: Record<Kind, string[]> = {
  exports: [
    'ledger_id',
    'sku',
    'export_date',
    'site',
    'quantity',
    'received_qty',
    'currency',
    'fob_cny',
    'expected_tax',
  ],
  sales: [
    'month',
    'settlement_id',
    'sku',
    'ledger_id',
    'net_qty',
    'net_amount',
    'receipt_status',
    'evidence_status',
  ],
  receipts: [
    'settlement_id',
    'currency',
    'net_amount',
    'allocated',
    'allocation_difference',
    'received_date',
    'received_amount',
  ],
  taxes: ['ledger_id', 'method', 'quantity', 'amount', 'deadline', 'days_left', 'status'],
  exceptions: ['event_date', 'ledger_id', 'type', 'quantity', 'amount', 'tax_adjustment'],
  documents: [
    'declaration_no',
    'declaration_date',
    'completeness',
    'timeliness',
    'deadline',
    'location',
  ],
  skus: ['sku', 'name', 'fnsku', 'asin', 'hs_code', 'unit', 'tax_rate'],
};
export function Badge({ children, value }: { children?: React.ReactNode; value?: any }) {
  return <span className={'badge ' + tone(value ?? children)}>{children ?? value}</span>;
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
  busy = false,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (busy) ref.current?.focus();
  }, [busy]);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
      }
      if (e.key === 'Tab') {
        const elements = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],summary,[tabindex="0"]',
          ) || [],
        ).filter((element) => element.getClientRects().length > 0);
        if (!elements.length) {
          e.preventDefault();
          ref.current?.focus();
          return;
        }
        const first = elements[0],
          last = elements[elements.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first || document.activeElement === ref.current)
        ) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handle);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handle);
      prior?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-busy={busy}
        aria-label={title}
        className={'modal ' + (wide ? 'wide' : '')}
      >
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭">
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
function Auth({ onSuccess }: { onSuccess: () => Promise<void> }) {
  const [register, setRegister] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const form = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await api('/auth/' + (register ? 'register' : 'login'), 'POST', form);
      await onSuccess();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <div className="auth-story">
        <div className="logo">
          <span className="logo-mark">
            <Layers3 size={24} />
          </span>
          <strong>
            9810<span>出口核销</span>
          </strong>
        </div>
        <div className="story-content">
          <div className="eyebrow">CROSS-BORDER OPERATIONS</div>
          <h1>
            每一票出口，
            <br />
            都有清晰的归程。
          </h1>
          <p>
            从报关、入仓到销售与收汇，
            <br />
            把海外仓业务连成一本清楚的账。
          </p>
          <div className="story-flow">
            {[Ship, Package, ShoppingBag, Wallet, FolderCheck].map((Icon, i) => (
              <React.Fragment key={i}>
                <div>
                  <Icon size={24} />
                  <span>{['报关', '入仓', '销售', '收汇', '核销'][i]}</span>
                </div>
                {i < 4 && <span className="flow-line" />}
              </React.Fragment>
            ))}
          </div>
          <div className="story-note">
            <ShieldCheck size={17} /> 企业独立空间 · 团队协作 · 变更留痕
          </div>
        </div>
        <div className="story-footer">
          9810 OPERATIONS WORKSPACE <span>把复杂的流程，变成有序的日常。</span>
        </div>
      </div>
      <div className="auth-panel">
        <form onSubmit={submit} className="auth-form">
          <span className="small-brand">欢迎使用 9810</span>
          <h2>{register ? '创建你的企业空间' : '登录工作空间'}</h2>
          <p>
            {register
              ? '建立账号，开始管理你的出口核销业务。'
              : '回到你的台账，继续推动每一票业务。'}
          </p>
          {new URLSearchParams(location.search).has('invite') && (
            <div className="inline-info">
              请使用受邀邮箱{register ? '注册' : '登录'}，完成后将加入邀请企业。
            </div>
          )}
          {register && (
            <>
              <label>
                你的姓名
                <input name="name" required placeholder="怎么称呼你" autoComplete="name" />
              </label>
              <label>
                企业名称
                <input
                  name="company_name"
                  required
                  placeholder="请输入企业名称"
                  autoComplete="organization"
                />
              </label>
            </>
          )}
          <label>
            邮箱地址
            <input
              name="email"
              type="email"
              required
              placeholder="name@company.com"
              autoComplete="email"
            />
          </label>
          <label>
            登录密码
            <input
              name="password"
              type="password"
              minLength={register ? 10 : 1}
              maxLength={128}
              required
              placeholder={register ? '至少 10 个字符' : '请输入密码'}
              autoComplete={register ? 'new-password' : 'current-password'}
            />
          </label>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <button className="primary auth-submit" disabled={busy}>
            {busy ? <Loader2 size={18} className="spin" /> : null}
            {register ? '创建企业空间' : '登录'}
            <ArrowRight size={17} />
          </button>
          <div className="auth-toggle">
            {register ? '已有账号？' : '第一次使用？'}
            <button
              type="button"
              onClick={() => {
                setRegister(!register);
                setError('');
              }}
            >
              {register ? '立即登录' : '创建企业空间'}
            </button>
          </div>
          <div className="auth-fine">基于亚马逊 FBA · 9810 出口海外仓核销台账</div>
        </form>
      </div>
    </div>
  );
}
function App() {
  const [state, setState] = useState<State | null>(null),
    [loading, setLoading] = useState(true),
    [bootError, setBootError] = useState(''),
    [page, setPage] = useState<Page>('dashboard'),
    [mobile, setMobile] = useState(false),
    [toast, setToast] = useState(''),
    [editor, setEditor] = useState<{ kind: Kind; row?: Row; defaults?: Row } | null>(null),
    [importing, setImporting] = useState(false),
    [fifo, setFifo] = useState(false),
    [detail, setDetail] = useState<Row | null>(null),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all'),
    [site, setSite] = useState(''),
    [currency, setCurrency] = useState('USD'),
    [pageNo, setPageNo] = useState(1),
    [allFields, setAllFields] = useState(false),
    [compact, setCompact] = useState(() => window.matchMedia('(max-width: 760px)').matches),
    [pageDirty, setPageDirty] = useState(false),
    [pageBusy, setPageBusy] = useState(false),
    [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const stateRequest = useRef<{ sequence: number; controller?: AbortController }>({ sequence: 0 });
  const currentTenant = useRef<string | null>(null);
  const modalOpen = Boolean(editor || importing || fifo || detail);
  const rows = useMemo<Row[]>(
    () =>
      !state
        ? []
        : page === 'dashboard'
          ? state.ledger
          : kindOrder.includes(page as Kind)
            ? state.records[page as Kind]
            : [],
    [state, page],
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!needle || JSON.stringify(r).toLowerCase().includes(needle)) &&
        (!site || r.site === site) &&
        (filter === 'all' ||
          (filter === 'attention' && r.alerts?.length) ||
          (filter === 'received' && r.receipt_status === '已售部分已收汇')),
    );
  }, [rows, query, site, filter]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 10));
  const currentPage = Math.min(pageNo, pageCount);
  const shown = filtered.slice((currentPage - 1) * 10, currentPage * 10);
  useEffect(() => setPageNo((n) => Math.min(n, pageCount)), [pageCount]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => {
      setCompact(media.matches);
      if (!media.matches) setMobile(false);
    };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!compact || !mobile) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    sidebarRef.current?.querySelector<HTMLButtonElement>('[aria-label="关闭导航"]')?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobile(false);
      }
      if (event.key !== 'Tab') return;
      const elements = Array.from(
        sidebarRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]),select:not([disabled]),a[href]',
        ) || [],
      ).filter((el) => el.getClientRects().length > 0);
      const first = elements[0],
        last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', handle);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handle);
      menuButtonRef.current?.focus();
    };
  }, [compact, mobile]);
  useEffect(() => {
    if (!pageDirty) return;
    const handle = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handle);
    return () => window.removeEventListener('beforeunload', handle);
  }, [pageDirty]);
  function resetWorkspaceView() {
    setPage('dashboard');
    setPageDirty(false);
    setPageBusy(false);
    setMobile(false);
    setEditor(null);
    setImporting(false);
    setFifo(false);
    setDetail(null);
    setQuery('');
    setSite('');
    setFilter('all');
    setPageNo(1);
    setAllFields(false);
  }
  function canLeave() {
    return !pageBusy && (!pageDirty || window.confirm('企业设置尚未保存，确定离开并放弃修改？'));
  }
  async function load(workspaceId = getWorkspaceId()) {
    stateRequest.current.controller?.abort();
    const controller = new AbortController();
    const sequence = ++stateRequest.current.sequence;
    stateRequest.current.controller = controller;
    try {
      let data: State;
      try {
        data = await api<State>('/state', 'GET', undefined, {
          workspaceId,
          signal: controller.signal,
        });
      } catch (e: any) {
        if (e.status !== 403 || !workspaceId) throw e;
        // A removed membership or another signed-in account invalidates this tab's saved choice.
        data = await api<State>('/state', 'GET', undefined, {
          workspaceId: null,
          signal: controller.signal,
        });
      }
      if (sequence !== stateRequest.current.sequence) return;
      if (currentTenant.current !== data.user.tenant_id) resetWorkspaceView();
      if (data.user.role !== 'owner' && ['settings', 'team', 'audit'].includes(page))
        setPage('dashboard');
      currentTenant.current = data.user.tenant_id;
      setWorkspaceId(data.user.tenant_id);
      setState(data);
      setSyncedAt(new Date());
      setBootError('');
    } catch (e: any) {
      if (controller.signal.aborted || sequence !== stateRequest.current.sequence) return;
      if (e.status === 401) {
        setWorkspaceId(null);
        currentTenant.current = null;
        setState(null);
        resetWorkspaceView();
      } else throw e;
    } finally {
      if (sequence === stateRequest.current.sequence) setLoading(false);
    }
  }
  useEffect(() => {
    load().catch((e) => setBootError(e.message));
    return () => stateRequest.current.controller?.abort();
  }, []);
  useEffect(() => {
    setQuery('');
    setSite('');
    setFilter('all');
    setPageNo(1);
    setAllFields(false);
  }, [page]);
  useEffect(() => {
    setPageNo(1);
  }, [query, filter, site]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  async function authenticated() {
    setWorkspaceId(null);
    const token = new URLSearchParams(location.search).get('invite');
    if (token) {
      const joined = await api<{ tenant_id: string }>(
        '/invitations/accept',
        'POST',
        { token },
        { workspaceId: null },
      );
      history.replaceState(null, '', location.pathname);
      await load(joined.tenant_id);
    } else await load(null);
  }
  async function acceptInvitation() {
    if (busy || !canLeave()) return;
    setBusy(true);
    try {
      const joined = await api<{ tenant_id: string }>('/invitations/accept', 'POST', {
        token: new URLSearchParams(location.search).get('invite'),
      });
      history.replaceState(null, '', location.pathname);
      await load(joined.tenant_id);
      setToast('已加入邀请企业');
    } catch (e: any) {
      setToast(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function switchWorkspace(tenantId: string) {
    if (busy || !canLeave()) return;
    setBusy(true);
    setLoading(true);
    try {
      const result = await api<{ tenant_id: string }>('/workspaces/switch', 'POST', {
        tenant_id: tenantId,
      });
      await load(result.tenant_id);
      setToast('已切换企业');
    } catch (e: any) {
      setToast(e.message);
    } finally {
      setLoading(false);
      setBusy(false);
    }
  }
  async function changed(message = '已保存，核算结果已更新') {
    await load();
    setToast(message);
  }
  async function action(fn: () => Promise<any>, message?: string) {
    setBusy(true);
    try {
      await fn();
      await changed(message);
    } catch (e: any) {
      setToast(e.message);
    } finally {
      setBusy(false);
    }
  }
  function nav(next: Page) {
    if (next !== page && !canLeave()) return;
    setPageDirty(false);
    setPage(next);
    setMobile(false);
  }
  if (loading)
    return (
      <div className="boot">
        <Layers3 size={36} />
        <Loader2 className="spin" />
        <p>正在打开工作空间…</p>
      </div>
    );
  if (bootError)
    return (
      <div className="boot">
        <AlertCircle />
        <p>{bootError}</p>
        <button
          onClick={() => {
            setLoading(true);
            load().catch((e) => setBootError(e.message));
          }}
        >
          重试
        </button>
      </div>
    );
  if (!state) return <Auth onSuccess={authenticated} />;
  const editable = state.user.role !== 'viewer';
  const owner = state.user.role === 'owner';
  const firstSkuNeeded = (page === 'dashboard' || page === 'exports') && !state.records.skus.length;
  const empty = state.stats.export_count === 0;
  const currentCurrency = Object.keys(state.stats.currencies).includes(currency)
    ? currency
    : Object.keys(state.stats.currencies)[0] || 'USD';
  const fx = state.stats.currencies[currentCurrency] || { net_revenue: 0, received: 0, pending: 0 };
  const alerts = state.ledger
    .flatMap((r) => r.alerts.map((a: Row) => ({ ...a, ledger: r })))
    .sort((a, b) => (a.level === 'danger' ? 0 : 1) - (b.level === 'danger' ? 0 : 1));
  function add(kind: Kind, defaults?: Row) {
    setEditor({ kind, defaults });
  }
  const counters = [
    {
      label: '报关总数量',
      value: num(state.stats.quantity),
      unit: '件',
      foot: `${state.stats.export_count} 个核销项目`,
      icon: Ship,
      color: 'mint',
    },
    {
      label: '在仓未售库存',
      value: num(state.stats.remaining),
      unit: '件',
      foot: `累计净售出 ${num(state.stats.net_sold)} 件`,
      icon: Boxes,
      color: 'blue',
    },
    {
      label: '累计净回款',
      value: cash(fx.net_revenue, currentCurrency),
      unit: '',
      foot: `已收汇 ${cash(fx.received, currentCurrency)}`,
      icon: Wallet,
      color: 'purple',
    },
    {
      label: '已申报预退税',
      value: cash(state.stats.prepaid_tax),
      unit: '',
      foot: `${state.stats.pending_tax} 个项目待核算`,
      icon: CircleDollarSign,
      color: 'orange',
    },
  ];
  return (
    <div className="app-shell">
      <aside
        ref={sidebarRef}
        id="workspace-navigation"
        className={'sidebar ' + (mobile ? 'visible' : '')}
        inert={modalOpen || (compact && !mobile)}
        aria-hidden={compact && !mobile ? true : undefined}
        role={compact && mobile ? 'dialog' : undefined}
        aria-modal={compact && mobile ? true : undefined}
        aria-label="工作空间导航"
      >
        <div className="logo">
          <span className="logo-mark">
            <Layers3 size={23} />
          </span>
          <strong>
            9810<span>出口核销</span>
          </strong>
          <button
            className="mobile-only icon-button"
            onClick={() => setMobile(false)}
            aria-label="关闭导航"
          >
            <X size={18} />
          </button>
        </div>
        <div className="workspace-switch">
          <span className="workspace-avatar">
            <Building2 size={19} />
          </span>
          <div>
            <small>企业工作空间</small>
            <select
              aria-label="切换企业"
              value={state.user.tenant_id}
              disabled={busy || pageBusy}
              onChange={(e) => {
                const target = e.target.value;
                e.target.value = state.user.tenant_id;
                switchWorkspace(target);
              }}
            >
              {state.workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
          <ChevronsUpDown size={14} />
        </div>
        <div className="nav-label">工作空间</div>
        <nav>
          <button
            className={page === 'dashboard' ? 'active' : ''}
            aria-current={page === 'dashboard' ? 'page' : undefined}
            onClick={() => nav('dashboard')}
          >
            <LayoutDashboard size={18} />
            工作台
            {state.stats.risk_count > 0 && (
              <span className="nav-count">{state.stats.risk_count}</span>
            )}
          </button>
          <div className="nav-label">业务台账</div>
          {kindOrder
            .filter((k) => k !== 'skus')
            .map((k) => {
              const Icon = icons[k];
              return (
                <button
                  key={k}
                  className={page === k ? 'active' : ''}
                  aria-current={page === k ? 'page' : undefined}
                  onClick={() => nav(k)}
                >
                  <Icon size={18} />
                  {labels[k]}
                  <span className="nav-order">0{kindOrder.indexOf(k) + 1}</span>
                </button>
              );
            })}
          <div className="nav-label">管理</div>
          {(['skus', ...(owner ? ['settings', 'team', 'audit'] : [])] as Page[]).map((k) => {
            const Icon = icons[k];
            return (
              <button
                key={k}
                className={page === k ? 'active' : ''}
                aria-current={page === k ? 'page' : undefined}
                onClick={() => nav(k)}
              >
                <Icon size={18} />
                {labels[k]}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="storage-note">
            <ShieldCheck size={15} />
            <span>企业数据独立保存</span>
          </div>
          <div className="user-card">
            <div className="avatar">{state.user.name.slice(0, 1).toUpperCase()}</div>
            <div>
              <strong>{state.user.name}</strong>
              <small>{roles[state.user.role]}</small>
            </div>
            <button
              title="退出登录"
              className="icon-button"
              disabled={busy}
              onClick={() => {
                if (canLeave())
                  action(async () => {
                    await api('/auth/logout', 'POST');
                    setWorkspaceId(null);
                  }, '已退出');
              }}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      {mobile && <div className="sidebar-scrim" onClick={() => setMobile(false)} />}
      <div className="main-shell" inert={modalOpen || (compact && mobile)}>
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="mobile-only icon-button"
              ref={menuButtonRef}
              onClick={() => setMobile(true)}
              aria-expanded={mobile}
              aria-controls="workspace-navigation"
              aria-label="打开导航"
            >
              <Menu size={20} />
            </button>
            <span>工作空间</span>
            <ChevronRight size={14} />
            <strong>{labels[page]}</strong>
          </div>
          <div className="topbar-right">
            <span className="saved-dot" />
            <span title={syncedAt?.toLocaleString('zh-CN')}>
              已同步 {syncedAt?.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
            </span>
            <span className="top-divider" />
            <span className="today">
              {new Intl.DateTimeFormat('zh-CN', {
                timeZone: 'Asia/Shanghai',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              }).format(new Date())}
            </span>
            <button
              className="icon-button"
              title="刷新数据"
              disabled={busy}
              onClick={() => {
                if (canLeave()) action(async () => {}, '已刷新');
              }}
            >
              <RefreshCw size={16} className={busy ? 'spin' : ''} />
            </button>
          </div>
        </header>
        <main>
          {new URLSearchParams(location.search).has('invite') && (
            <div className="invitation-banner">
              <Users size={18} />
              <span>收到企业邀请 · 当前登录 {state.user.email}</span>
              <button className="primary" disabled={busy} onClick={acceptInvitation}>
                接受邀请
                <ArrowRight size={15} />
              </button>
            </div>
          )}
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {page === 'dashboard' ? 'OPERATIONS OVERVIEW' : '9810 WORKSPACE'}
              </div>
              <h1>
                {page === 'dashboard' ? '核销工作台' : labels[page]}
                {page === 'dashboard' && <span className="live-tag">核算概览</span>}
              </h1>
              <p>
                {page === 'dashboard'
                  ? '连接每一个业务环节，让出口、库存与资金流向清晰可见。'
                  : kindOrder.includes(page as Kind)
                    ? state.schema[page as Kind].description
                    : page === 'settings'
                      ? '维护企业信息与核算规则，所有调整都会记录在操作日志中。'
                      : page === 'team'
                        ? '邀请同事加入企业，为每个人分配合适的访问权限。'
                        : '回溯数据变更、导入与导出，保留业务处理记录。'}
              </p>
            </div>
            <div className="heading-actions">
              {(page === 'dashboard' || kindOrder.includes(page as Kind)) && (
                <>
                  <button onClick={() => setImporting(true)} disabled={!editable || busy}>
                    <ArrowUpFromLine size={16} />
                    导入 Excel
                  </button>
                  {editable && (
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        add(
                          firstSkuNeeded
                            ? 'skus'
                            : page === 'dashboard'
                              ? 'exports'
                              : (page as Kind),
                        )
                      }
                    >
                      <Plus size={18} />
                      {firstSkuNeeded
                        ? '建立 SKU 档案'
                        : page === 'dashboard'
                          ? '新建报关'
                          : '新增记录'}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
          {page === 'dashboard' && (
            <>
              <div className="stats-grid">
                {counters.map((s, i) => (
                  <div className="stat-card" key={s.label}>
                    <div className="stat-top">
                      <span>{s.label}</span>
                      <span className={'stat-icon ' + s.color}>
                        <s.icon size={18} />
                      </span>
                    </div>
                    <div className="stat-number">
                      {s.value}
                      <span>{s.unit}</span>
                    </div>
                    <div className="stat-bottom">
                      <span>{s.foot}</span>
                      {i === 2 ? (
                        <select
                          aria-label="回款币种"
                          value={currentCurrency}
                          onChange={(e) => setCurrency(e.target.value)}
                        >
                          {(Object.keys(state.stats.currencies).length
                            ? Object.keys(state.stats.currencies)
                            : ['USD']
                          ).map((c) => (
                            <option key={c}>{c}</option>
                          ))}
                        </select>
                      ) : (
                        <ArrowUpRight size={14} />
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div className="workflow-card">
                <div className="workflow-title">
                  <span className="mini-icon">
                    <Layers3 size={17} />
                  </span>
                  <strong>出口核销链路</strong>
                  <span>每一步，都有迹可循</span>
                </div>
                <div className="workflow-steps">
                  {[
                    {
                      title: '报关出口',
                      detail: `${state.stats.export_count} 个报关项目`,
                      icon: Ship,
                      page: 'exports',
                    },
                    {
                      title: 'FBA 入仓',
                      detail: `${num(state.ledger.reduce((a, r) => a + Number(r.received_qty || 0), 0))} 件已签收`,
                      icon: Package,
                      page: 'exports',
                    },
                    {
                      title: '销售核销',
                      detail: `${num(state.stats.net_sold)} 件净售出`,
                      icon: ShoppingBag,
                      page: 'sales',
                    },
                    {
                      title: '回款收汇',
                      detail: `${state.records.receipts.length} 份结算报告`,
                      icon: Wallet,
                      page: 'receipts',
                    },
                    {
                      title: '退税与留存',
                      detail: `${state.stats.pending_tax} 项待核算`,
                      icon: FolderCheck,
                      page: 'taxes',
                    },
                  ].map((s, i) => (
                    <React.Fragment key={s.title}>
                      <button className="workflow-step" onClick={() => nav(s.page as Page)}>
                        <div className={'step-icon ' + (i === 0 ? 'filled' : '')}>
                          <s.icon size={20} />
                        </div>
                        <div>
                          <strong>
                            {s.title}
                            <span>0{i + 1}</span>
                          </strong>
                          <small>{s.detail}</small>
                        </div>
                      </button>
                      {i < 4 && <ChevronRight size={16} className="step-chevron" />}
                    </React.Fragment>
                  ))}
                </div>
              </div>
            </>
          )}
          {(page === 'dashboard' || kindOrder.includes(page as Kind)) && (
            <div className={page === 'dashboard' ? 'content-grid' : 'single-content'}>
              <section className="panel ledger-panel">
                <div className="panel-heading">
                  <div>
                    <h2>
                      {page === 'dashboard' ? '核销总表' : labels[page] + '台账'}
                      <span className="count-tag">{rows.length}</span>
                    </h2>
                    <p>
                      {page === 'dashboard'
                        ? '按报关项追踪库存、资金与退税进度'
                        : '自动字段随关联台账实时更新'}
                    </p>
                  </div>
                  <div className="table-actions">
                    {page === 'sales' && editable && (
                      <button className="small-button" onClick={() => setFifo(true)}>
                        <Layers3 size={15} />
                        FIFO 分配
                      </button>
                    )}
                    {page !== 'dashboard' && (
                      <button
                        className={'small-button ' + (allFields ? 'selected' : '')}
                        onClick={() => setAllFields(!allFields)}
                      >
                        <SlidersHorizontal size={15} />
                        {allFields ? '常用字段' : '全部字段'}
                      </button>
                    )}
                    <a
                      className="button small-button"
                      href={downloadUrl('/export', state.user.tenant_id)}
                    >
                      <ArrowDownToLine size={15} />
                      导出
                    </a>
                  </div>
                </div>
                <div className="table-toolbar">
                  {page === 'dashboard' ? (
                    <div className="tabs">
                      <button
                        className={filter === 'all' ? 'selected' : ''}
                        onClick={() => setFilter('all')}
                      >
                        全部项目
                      </button>
                      <button
                        className={filter === 'attention' ? 'selected' : ''}
                        onClick={() => setFilter('attention')}
                      >
                        需要关注<span>{state.stats.risk_count}</span>
                      </button>
                      <button
                        className={filter === 'received' ? 'selected' : ''}
                        onClick={() => setFilter('received')}
                      >
                        已收汇
                      </button>
                    </div>
                  ) : (
                    <span className="table-hint">
                      <Info size={14} />
                      点击记录查看与编辑
                    </span>
                  )}
                  <div className="filters">
                    <div className="search">
                      <Search size={15} />
                      <input
                        aria-label="搜索台账"
                        placeholder="搜索编号、SKU…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </div>
                    {rows.some((r) => r.site) && (
                      <select
                        aria-label="站点筛选"
                        value={site}
                        onChange={(e) => setSite(e.target.value)}
                      >
                        <option value="">全部站点</option>
                        {Array.from(new Set(rows.map((r) => r.site).filter(Boolean))).map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
                {!rows.length ? (
                  <div className="empty-state">
                    <div className="empty-icon">
                      <FileSpreadsheet size={32} />
                    </div>
                    <h3>
                      {page === 'dashboard' ? '从第一票报关开始' : `还没有${labels[page]}记录`}
                    </h3>
                    <p>
                      {page === 'dashboard'
                        ? '导入现有 Excel，或先体验原模板的示例数据。'
                        : '新增记录或导入原模板，建立你的业务台账。'}
                    </p>
                    {editable && (
                      <div>
                        <button
                          className="primary"
                          disabled={busy}
                          onClick={() =>
                            add(
                              firstSkuNeeded
                                ? 'skus'
                                : page === 'dashboard'
                                  ? 'exports'
                                  : (page as Kind),
                            )
                          }
                        >
                          <Plus size={16} />
                          {firstSkuNeeded ? '先建立 SKU 档案' : '新增记录'}
                        </button>
                        {empty && Object.values(state.records).every((rs) => rs.length === 0) && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              action(() => api('/demo', 'POST'), '已载入原模板示例数据')
                            }
                          >
                            体验示例数据
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ) : !filtered.length ? (
                  <div className="empty-state compact">
                    <Search size={26} />
                    <h3>没有符合条件的记录</h3>
                    <button
                      onClick={() => {
                        setQuery('');
                        setSite('');
                        setFilter('all');
                      }}
                    >
                      清除筛选
                    </button>
                  </div>
                ) : (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          {page === 'dashboard' ? (
                            <>
                              <th>核销编号 / 商品</th>
                              <th>报关 / 签收</th>
                              <th>销售进度</th>
                              <th>在仓未售</th>
                              <th>收汇状态</th>
                              <th>核算状态</th>
                              <th />
                            </>
                          ) : (
                            <>
                              {state.schema[page as Kind].fields
                                .filter(
                                  (f) => allFields || visibleFields[page as Kind].includes(f.key),
                                )
                                .map((f) => (
                                  <th key={f.key}>
                                    {f.label}
                                    {f.computed && <span className="auto-dot" title="自动计算" />}
                                  </th>
                                ))}
                              <th>操作</th>
                            </>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((r) => (
                          <tr
                            key={r.id}
                            onClick={() =>
                              page === 'dashboard'
                                ? setDetail(r)
                                : setEditor({ kind: page as Kind, row: r })
                            }
                          >
                            {page === 'dashboard' ? (
                              <>
                                <td>
                                  <button
                                    className="row-link"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setDetail(r);
                                    }}
                                  >
                                    {r.ledger_id}
                                    <ArrowUpRight size={12} />
                                  </button>
                                  <div className="secondary-cell">
                                    <span className="sku-square">
                                      <Package size={12} />
                                    </span>
                                    {r.sku}
                                    <span className="light-dot">·</span>
                                    {r.name}
                                  </div>
                                </td>
                                <td>
                                  <strong className="tabular">{num(r.quantity)}</strong>
                                  <span className="sub-line">
                                    {r.received_qty === undefined
                                      ? '待签收'
                                      : num(r.received_qty) + ' 已签收'}
                                    {r.warehouse_difference !== 0 &&
                                      r.warehouse_difference !== null && (
                                        <span className="diff">
                                          {r.warehouse_difference > 0 ? '+' : ''}
                                          {r.warehouse_difference}
                                        </span>
                                      )}
                                  </span>
                                </td>
                                <td>
                                  <div className="progress-label">
                                    <span>{num(r.net_sold)} 件</span>
                                    <small>{r.progress}%</small>
                                  </div>
                                  <div className="progress-bar">
                                    <span
                                      style={{
                                        width: Math.min(100, Math.max(0, r.progress)) + '%',
                                      }}
                                    />
                                  </div>
                                </td>
                                <td>
                                  <strong className="tabular">{num(r.remaining)}</strong>
                                  <span className="sub-line">{r.site || '—'}</span>
                                </td>
                                <td>
                                  <Badge value={r.receipt_status} />
                                  <span className="sub-line">
                                    {cash(r.received_amount, r.currency)}
                                  </span>
                                </td>
                                <td>
                                  <Badge value={r.tax_status} />
                                  <span className="sub-line">{r.tax_deadline || '无需核算'}</span>
                                </td>
                                <td>
                                  <ChevronRight size={16} className="muted" />
                                </td>
                              </>
                            ) : (
                              <>
                                {state.schema[page as Kind].fields
                                  .filter(
                                    (f) => allFields || visibleFields[page as Kind].includes(f.key),
                                  )
                                  .map((f, i) => (
                                    <td
                                      key={f.key}
                                      className={
                                        (f.computed ? 'computed-cell ' : '') +
                                        (i === 0 ? 'strong-cell' : '')
                                      }
                                    >
                                      {statusFields.has(f.key) ? (
                                        <Badge value={r[f.key]} />
                                      ) : (
                                        display(r[f.key], f)
                                      )}
                                    </td>
                                  ))}
                                <td>
                                  <button
                                    className="text-button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setEditor({ kind: page as Kind, row: r });
                                    }}
                                  >
                                    {editable ? '编辑' : '查看'}
                                    <ChevronRight size={13} />
                                  </button>
                                </td>
                              </>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="table-footer">
                  <span>
                    共 {filtered.length} 条记录{page === 'dashboard' && ' · 每个报关项独立核销'}
                  </span>
                  <div>
                    <button
                      className="icon-button"
                      disabled={currentPage === 1}
                      onClick={() => setPageNo(currentPage - 1)}
                      aria-label="上一页"
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <span>
                      {currentPage} / {pageCount}
                    </span>
                    <button
                      className="icon-button"
                      disabled={currentPage >= pageCount}
                      onClick={() => setPageNo(currentPage + 1)}
                      aria-label="下一页"
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </div>
              </section>
              {page === 'dashboard' && (
                <aside className="insights">
                  <section className="panel attention-panel">
                    <div className="panel-heading">
                      <h2>
                        待办与提醒<span className="count-tag amber">{alerts.length}</span>
                      </h2>
                      <span className="small-icon">
                        <AlertCircle size={17} />
                      </span>
                    </div>
                    <div className="attention-list">
                      {alerts.slice(0, 4).map((a, i) => (
                        <button
                          key={i}
                          className="attention-item"
                          onClick={() => setDetail(a.ledger)}
                        >
                          <span className={'alert-dot ' + a.level}>
                            <AlertCircle size={15} />
                          </span>
                          <div>
                            <strong>{a.text}</strong>
                            <p>
                              {a.ledger.sku} · {a.ledger.ledger_id.slice(-6)}
                            </p>
                          </div>
                          <ChevronRight size={15} />
                        </button>
                      ))}
                      {!alerts.length && (
                        <div className="all-good">
                          <CheckCircle2 size={27} />
                          <strong>当前没有待处理提醒</strong>
                          <span>业务变化后会自动更新</span>
                        </div>
                      )}
                    </div>
                    {alerts.length > 4 && (
                      <button className="panel-link" onClick={() => setFilter('attention')}>
                        查看全部关注项目
                        <ArrowRight size={14} />
                      </button>
                    )}
                    <div className="attention-foot">
                      <Clock3 size={13} />
                      核算截止前 {state.settings.warning_days} 天提醒
                    </div>
                  </section>
                  <section className="panel receipt-panel">
                    <div className="panel-heading">
                      <h2>收汇概览</h2>
                      <span className="currency-tag">{currentCurrency}</span>
                    </div>
                    <div className="receipt-number">{cash(fx.received, currentCurrency)}</div>
                    <p>已进入境内银行账户</p>
                    <div className="receipt-track">
                      <span
                        style={{
                          width:
                            (fx.net_revenue > 0
                              ? Math.min(100, (fx.received / fx.net_revenue) * 100)
                              : 0) + '%',
                        }}
                      />
                    </div>
                    <div className="receipt-legend">
                      <span>
                        <i />
                        已收汇
                      </span>
                      <strong>
                        {fx.net_revenue > 0
                          ? ((fx.received / fx.net_revenue) * 100).toFixed(1)
                          : '0'}
                        %
                      </strong>
                    </div>
                    <div className="receipt-pending">
                      <span>待收汇净额</span>
                      <strong>{cash(fx.pending, currentCurrency)}</strong>
                    </div>
                    <button className="panel-link" onClick={() => nav('receipts')}>
                      前往回款台账
                      <ArrowRight size={14} />
                    </button>
                  </section>
                  <div className="quiet-note">
                    <Info size={15} />
                    <p>以“报关单号－项号”串联业务。原币金额按币种独立汇总。</p>
                  </div>
                </aside>
              )}
            </div>
          )}
          {owner && page === 'settings' && (
            <SettingsPanel
              key={state.user.tenant_id}
              state={state}
              onChanged={changed}
              onDirtyChange={setPageDirty}
              onBusyChange={setPageBusy}
            />
          )}
          {owner && page === 'team' && (
            <TeamPanel key={state.user.tenant_id} onChanged={changed} state={state} />
          )}
          {owner && page === 'audit' && (
            <AuditPanel key={state.user.tenant_id} revision={state.revision} />
          )}
          <footer className="page-footer">
            <span>
              <span className="footer-logo">9810</span> 出口海外仓核销工作空间
            </span>
            <span>业务日期：北京时间 · 规则可在企业设置中维护</span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Info size={17} />
          {toast}
          <button onClick={() => setToast('')} aria-label="关闭通知">
            <X size={15} />
          </button>
        </div>
      )}
      {editor && (
        <RecordEditor
          state={state}
          {...editor}
          onClose={() => setEditor(null)}
          onChanged={changed}
        />
      )}
      {importing && (
        <ImportDialog state={state} onClose={() => setImporting(false)} onChanged={changed} />
      )}
      {fifo && <FifoDialog state={state} onClose={() => setFifo(false)} onChanged={changed} />}
      {detail && (
        <Modal
          title="核销项目详情"
          subtitle={detail.ledger_id}
          wide
          onClose={() => setDetail(null)}
        >
          <div className="detail-body">
            <div className="detail-product">
              <span className="product-icon">
                <Package size={27} />
              </span>
              <div>
                <h3>{detail.name}</h3>
                <p>
                  {detail.sku} · {detail.site || '未设置站点'} · {detail.currency}
                </p>
              </div>
              <Badge value={detail.tax_status} />
            </div>
            <div className="detail-stats">
              {[
                ['报关数量', num(detail.quantity)],
                ['累计净售出', num(detail.net_sold)],
                ['在仓未售', num(detail.remaining)],
                ['累计净回款', cash(detail.net_revenue, detail.currency)],
              ].map(([a, b]) => (
                <div key={a}>
                  <small>{a}</small>
                  <strong>{b}</strong>
                </div>
              ))}
            </div>
            {detail.alerts.length > 0 && (
              <div className="detail-alerts">
                {detail.alerts.map((a: Row, i: number) => (
                  <div key={i}>
                    <AlertCircle size={15} />
                    {a.text}
                  </div>
                ))}
              </div>
            )}
            <div className="detail-dates">
              <div>
                <span>出口日期</span>
                <strong>{detail.export_date}</strong>
              </div>
              <div>
                <span>收汇截止日</span>
                <strong>{detail.receipt_deadline}</strong>
              </div>
              <div>
                <span>预退税核算截止日</span>
                <strong>{detail.tax_deadline || '—'}</strong>
              </div>
              <div>
                <span>单证情况</span>
                <Badge value={detail.document_status} />
              </div>
            </div>
            <h3 className="section-title">关联业务记录</h3>
            {(['sales', 'taxes', 'exceptions', 'documents'] as Kind[]).map((k) => {
              const related = state.records[k].filter((r) =>
                k === 'documents'
                  ? r.declaration_no === detail.declaration_no
                  : r.ledger_id === detail.ledger_id,
              );
              return (
                <div className="related-section" key={k}>
                  <div>
                    <strong>
                      {labels[k]}
                      <span className="count-tag">{related.length}</span>
                    </strong>
                    {editable && (
                      <button
                        className="text-button"
                        onClick={() => {
                          setDetail(null);
                          add(k, {
                            ledger_id: detail.ledger_id,
                            sku: detail.sku,
                            declaration_no: detail.declaration_no,
                            site: detail.site,
                          });
                        }}
                      >
                        <Plus size={14} />
                        新增
                      </button>
                    )}
                  </div>
                  {related.map((r) => (
                    <button
                      key={r.id}
                      className="related-row"
                      onClick={() => {
                        setDetail(null);
                        setEditor({ kind: k, row: r });
                      }}
                    >
                      <span>{r.settlement_id || r.reference || r.type || r.declaration_no}</span>
                      <span>
                        {r.month || r.declaration_date || r.event_date}
                        <ChevronRight size={15} />
                      </span>
                    </button>
                  ))}
                  {!related.length && <p className="muted">暂无关联记录</p>}
                </div>
              );
            })}
          </div>
          <div className="modal-footer">
            <button onClick={() => setDetail(null)}>关闭</button>
            <button
              className="primary"
              onClick={() => {
                const row = state.records.exports.find((r) => r.id === detail.id);
                setDetail(null);
                setEditor({ kind: 'exports', row });
              }}
            >
              {editable ? '编辑报关信息' : '查看报关信息'}
              <ArrowRight size={15} />
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);

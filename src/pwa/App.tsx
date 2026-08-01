import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from 'react';
import type { AttendanceApi } from '../shared/api';
import { normalizeNumericInput } from '../shared/input';
import { exportBackup, restoreBackupFile } from './local-api';
import './app.css';

type Employee = { id: string; name: string; hourlyWage?: number; status?: string; startedAt?: number; archived_at?: number; restore_until?: number };
type Notice = { kind: 'error' | 'success' | 'warning'; text: string } | null;
type View = 'clock' | 'state' | 'confirm' | 'done' | 'admin-auth' | 'admin' | 'recovery';
type Tab = '勤怠' | '月次' | '管理';
const api = () => window.attendance as AttendanceApi | undefined;
const requestId = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const time = (value?: number) => value ? new Date(value).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '—';
const isWorking = (value: any) => Boolean(value?.clock_in) && value.clock_out == null;

async function call(group: string, action: string, input?: any) {
  const fn = (api() as any)?.[group]?.[action];
  if (typeof fn !== 'function') throw new Error('アプリとの接続を確認できません。もう一度開き直してください。');
  const result = await fn(group === 'clock' && action === 'status' ? input.employeeId : input);
  if (result?.ok === false) throw new Error(result.message || '操作を完了できませんでした。');
  return result?.data ?? result;
}

export default function App() {
  const [view, setView] = useState<View>('clock');
  const [tab, setTab] = useState<Tab>('勤怠');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selected, setSelected] = useState<Employee | null>(null);
  const [search, setSearch] = useState('');
  const [now, setNow] = useState(new Date());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [adminConfigured, setAdminConfigured] = useState(true);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [updateReady, setUpdateReady] = useState(Boolean((window as Window & { __PWA_UPDATE_READY__?: boolean }).__PWA_UPDATE_READY__));
  const [updateRegistration, setUpdateRegistration] = useState<ServiceWorkerRegistration | null>(null);

  const loadHome = async () => {
    setLoading(true); setNotice(null);
    try {
      const result: any = await call('clock', 'home');
      setEmployees(Array.isArray(result?.employees) ? result.employees : Array.isArray(result) ? result : []);
      setAdminConfigured(result?.adminConfigured ?? true);
    } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : '打刻ホームを読み込めませんでした。' }); }
    finally { setLoading(false); }
  };
  useEffect(() => { void loadHome(); const id = window.setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id); }, []);
  useEffect(() => { const ready = (event: Event) => { setUpdateReady(true); setUpdateRegistration((event as CustomEvent<ServiceWorkerRegistration>).detail ?? null); }; window.addEventListener('attendance:update-ready', ready); return () => window.removeEventListener('attendance:update-ready', ready); }, []);
  useEffect(() => {
    if (view !== 'state' && view !== 'confirm') return;
    const id = window.setTimeout(() => { setSelected(null); setView('clock'); }, 30_000);
    return () => clearTimeout(id);
  }, [view]);
  useEffect(() => { if (view === 'done') { const id = window.setTimeout(() => { setView('clock'); setSelected(null); void loadHome(); }, 5000); return () => clearTimeout(id); } }, [view]);

  const visible = useMemo(() => employees.filter(e => e.name.includes(search.trim())), [employees, search]);
  const choose = async (employee: Employee) => {
    setSelected(employee); setView('state'); setLoading(true); setNotice(null);
    try {
      const state: any = await call('clock', 'status', { employeeId: employee.id });
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
      setSelected({ ...employee, status: isWorking(state) ? 'WORKING' : state?.clock_out && state.business_date === today ? 'CLOCKED_OUT_TODAY' : 'OFF', startedAt: state?.clock_in });
    } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : '勤務状態を確認できませんでした。' }); }
    finally { setLoading(false); }
  };
  const clockOut = selected?.status === 'WORKING';
  const saveClock = async () => {
    if (!selected) return;
    setBusy(true); setNotice(null);
    try { await call('clock', clockOut ? 'clockOut' : 'clockIn', { employeeId: selected.id, requestId: requestId(), reClockAcknowledged: selected.status === 'CLOCKED_OUT_TODAY' }); setView('done'); }
    catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : '打刻は保存されていません。もう一度お試しください。' }); }
    finally { setBusy(false); }
  };
  return <main className="pwa-shell">
    <LiveNotice notice={notice} clear={() => setNotice(null)} />
    {updateReady && <div className="update-banner" role="status"><span>アプリの更新を利用できます。</span><button onClick={() => { updateRegistration?.waiting?.postMessage({ type: 'SKIP_WAITING' }); window.setTimeout(() => window.location.reload(), 150); }}>更新する</button><button onClick={() => setUpdateReady(false)} aria-label="更新通知を閉じる">後で</button></div>}
    {view === 'clock' && <ClockHome now={now} employees={visible} search={search} setSearch={setSearch} loading={loading} choose={choose} openAdmin={() => setView('admin-auth')} retry={loadHome} />}
    {view === 'state' && <State employee={selected} loading={loading} next={() => setView('confirm')} back={() => setView('clock')} />}
    {view === 'confirm' && <Confirm employee={selected} clockOut={clockOut} busy={busy} back={() => setView('state')} submit={saveClock} />}
    {view === 'done' && <Done employee={selected} clockOut={clockOut} />}
    {view === 'admin-auth' && <AdminAuth configured={adminConfigured} back={() => setView('clock')} open={() => setView('admin')} recover={() => setView('recovery')} showRecovery={setRecoveryCode} />}
    {view === 'recovery' && <Recovery back={() => setView('admin-auth')} showRecovery={setRecoveryCode} />}
    {view === 'admin' && <Admin tab={tab} setTab={setTab} home={() => { setView('clock'); void loadHome(); }} />}
    {recoveryCode && <RecoveryCode code={recoveryCode} confirm={() => { setRecoveryCode(''); setView('admin'); }} />}
  </main>;
}

function LiveNotice({ notice, clear }: { notice: Notice; clear: () => void }) { return notice ? <div className={`notice ${notice.kind}`} role="alert"><span>{notice.text}</span><button onClick={clear} aria-label="通知を閉じる">×</button></div> : null; }
function ClockHome({ now, employees, search, setSearch, loading, choose, openAdmin, retry }: any) { return <section className="clock-page"><header className="clock-head"><p className="eyebrow">LOCAL ATTENDANCE</p><h1>打刻</h1><p className="today">{now.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' })}</p><output className="clock-time" aria-live="polite">{now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</output></header><div className="clock-body"><h2>お名前を選んでください</h2><label className="search"><span className="sr-only">氏名を検索</span><input value={search} onChange={e => setSearch(e.target.value)} placeholder="氏名を検索" inputMode="search" autoComplete="off" /></label>{loading ? <Loading label="従業員を読み込んでいます…" /> : employees.length ? <div className="employee-grid">{employees.map((e: Employee) => <button key={e.id} className="employee-card" onClick={() => choose(e)}><span>{e.name}</span><small>{e.status === 'WORKING' ? '勤務中' : e.status === 'CLOCKED_OUT_TODAY' ? '本日退勤済み' : 'タップして打刻'}</small></button>)}</div> : <Empty title="表示できる従業員がいません" text="管理者メニューから従業員を登録してください。" action="再読み込み" onAction={retry} />}</div><footer className="clock-footer"><span>このiPhone内に保存・オフライン利用可能</span><button className="link-button" onClick={openAdmin}>管理者メニュー</button></footer></section> }
function State({ employee, loading, next, back }: any) { const working = employee?.status === 'WORKING'; return <Flow back={back} step="1 / 2" title={`${employee?.name || '従業員'}さんの勤務状態`}><div className={`status-card ${working ? 'working' : ''}`}>{loading ? <Loading label="確認しています…" /> : <><strong>{working ? '勤務中です' : employee?.status === 'CLOCKED_OUT_TODAY' ? '本日は退勤済みです' : '現在は出勤していません'}</strong><span>{working ? `出勤時刻：${time(employee?.startedAt)}` : '内容を確認して次へ進んでください。'}</span></>}</div><button className="primary action-button" disabled={loading} onClick={next}>{working ? '退勤を確認する' : '出勤を確認する'}</button></Flow> }
function Confirm({ employee, clockOut, busy, back, submit }: any) { const rec = employee?.status === 'CLOCKED_OUT_TODAY'; return <Flow back={back} step="2 / 2" title={`${clockOut ? '退勤' : '出勤'}を確定しますか？`}><div className={`status-card ${rec ? 'warning' : ''}`}><strong>{employee?.name}さん</strong><span>{rec ? '本日はすでに退勤済みです。再出勤として記録します。' : `${time(Date.now())} に${clockOut ? '退勤' : '出勤'}を記録します。`}</span></div><button className="primary action-button" disabled={busy} onClick={submit}>{busy ? '保存しています…' : `${clockOut ? '退勤' : '出勤'}を確定する`}</button></Flow> }
function Done({ employee, clockOut }: any) { return <section className="flow done"><div className="check" aria-hidden>✓</div><p className="eyebrow">SAVED</p><h1>{clockOut ? '退勤を記録しました' : '出勤を記録しました'}</h1><p>{employee?.name}さん、おつかれさまです。</p><small>5秒後に打刻ホームへ戻ります。</small></section> }
function Flow({ back, step, title, children }: any) { return <section className="flow"><button className="back" onClick={back}>‹ 打刻へ戻る</button><p className="eyebrow">STEP {step}</p><h1>{title}</h1>{children}<small className="return">30秒操作がない場合は打刻ホームへ戻ります。</small></section> }
function AdminAuth({ configured, back, open, recover, showRecovery }: any) { const [pin, setPin] = useState(''); const [confirmation, setConfirmation] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const submit = async (e: FormEvent) => { e.preventDefault(); if (pin.length !== 6) return setError('PINは6桁の数字で入力してください。'); if (!configured && pin !== confirmation) return setError('PINと確認入力が一致しません。'); setBusy(true); setError(''); try { const result = await call('adminAuth', configured ? 'verify' : 'setup', { pin, requestId: requestId() }); if (!configured && result?.recoveryCode) showRecovery(result.recoveryCode); else open(); } catch (x) { setError(x instanceof Error ? x.message : 'PINを確認できませんでした。'); } finally { setBusy(false); } }; return <section className="auth flow"><button className="back" onClick={back}>‹ 打刻へ戻る</button><p className="eyebrow">ADMINISTRATOR</p><h1>{configured ? '管理者PINを入力' : '管理者PINを設定'}</h1><p>{configured ? '管理メニューを開くにはPINが必要です。' : '最初の管理者PINを6桁で設定してください。'}</p><form onSubmit={submit}><label>PIN（6桁）<input type="password" autoComplete={configured ? 'current-password' : 'new-password'} autoFocus inputMode="numeric" pattern="[0-9０-９]*" maxLength={6} value={pin} onChange={e => setPin(normalizeNumericInput(e.target.value, 6))} /></label>{!configured && <label>PIN（確認）<input type="password" autoComplete="new-password" inputMode="numeric" pattern="[0-9０-９]*" maxLength={6} value={confirmation} onChange={e => setConfirmation(normalizeNumericInput(e.target.value, 6))} /></label>}{error && <p className="form-error" role="alert">{error}</p>}<button className="primary action-button" disabled={busy}>{busy ? '確認しています…' : configured ? '認証する' : 'PINを設定する'}</button>{configured && <button className="link-button center" type="button" onClick={recover}>PINを忘れた場合</button>}</form></section> }
function Recovery({ back, showRecovery }: any) { const [code, setCode] = useState(''); const [pin, setPin] = useState(''); const [confirm, setConfirm] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const submit = async (e: FormEvent) => { e.preventDefault(); if (pin.length !== 6 || pin !== confirm) return setError('新しいPINを6桁で一致させてください。'); setBusy(true); try { const result = await call('adminAuth', 'resetWithRecovery', { recoveryCode: code.trim(), newPin: pin, requestId: requestId() }); if (!result?.recoveryCode) throw new Error('新しい回復コードを取得できませんでした。'); showRecovery(result.recoveryCode); } catch (x) { setError(x instanceof Error ? x.message : 'PINを再設定できませんでした。'); } finally { setBusy(false); } }; return <section className="auth flow"><button className="back" onClick={back}>‹ PIN入力へ戻る</button><p className="eyebrow">PIN RECOVERY</p><h1>管理者PINを再設定</h1><form onSubmit={submit}><label>回復コード<input type="password" autoComplete="off" value={code} onChange={e => setCode(e.target.value)} /></label><label>新しいPIN<input type="password" autoComplete="new-password" inputMode="numeric" maxLength={6} value={pin} onChange={e => setPin(normalizeNumericInput(e.target.value, 6))} /></label><label>新しいPIN（確認）<input type="password" autoComplete="new-password" inputMode="numeric" maxLength={6} value={confirm} onChange={e => setConfirm(normalizeNumericInput(e.target.value, 6))} /></label>{error && <p className="form-error">{error}</p>}<button className="primary action-button" disabled={busy}>{busy ? '再設定しています…' : 'PINを再設定する'}</button></form></section> }
function RecoveryCode({ code, confirm }: { code: string; confirm: () => void }) { return <div className="modal-backdrop"><section className="secret-card" role="dialog" aria-modal="true" aria-labelledby="recovery-code-title"><p className="eyebrow">ONE-TIME DISPLAY</p><h2 id="recovery-code-title">回復コードを保管してください</h2><p>このコードは再表示できません。紙など安全な場所に控えてください。</p><code>{code}</code><button className="primary action-button" onClick={confirm}>保存しました</button></section></div> }

const adminSections = ['概要', '従業員', '承認', '操作ログ', 'バックアップ', '設定'] as const;
function Admin({ tab, setTab, home }: { tab: Tab; setTab: (tab: Tab) => void; home: () => void }) {
  const [section, setSection] = useState<(typeof adminSections)[number]>('概要');
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const load = async () => {
    setLoading(true); setError('');
    try {
      let result: any;
      if (tab === '勤怠') result = await call('attendance', 'list');
      else if (tab === '月次') result = await call('monthly', 'detail', month);
      else if (section === '概要') {
        const dashboard = await call('operations', 'dashboard');
        result = {
          employees: dashboard?.employees?.n ?? dashboard?.employees ?? 0,
          openShifts: dashboard?.openShifts?.n ?? dashboard?.openShifts ?? 0,
          reviewShifts: dashboard?.reviewShifts?.n ?? dashboard?.reviewShifts ?? 0,
          latestBackup: dashboard?.latestBackup?.created_at ?? null,
        };
      }
      else if (section === '従業員') result = await call('employees', 'list', true);
      else if (section === '承認') result = await call('attendance', 'list', { reviewOnly: true });
      else if (section === '操作ログ') result = await call('operations', 'logs');
      else if (section === 'バックアップ') result = await call('backup', 'list');
      else result = await call('settings', 'get');
      const values = result?.items ?? result;
      setRows(Array.isArray(values) ? values : values == null ? [] : [values]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'データを読み込めませんでした。'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [tab, section, month]);
  const lock = async () => { await api()?.adminAuth.lock(); home(); };
  return <section className="admin-page"><header className="admin-head"><div><p className="eyebrow">ADMINISTRATION</p><h1>{tab === '管理' ? section : tab}</h1></div><button className="quiet-button" onClick={lock}>ロックして戻る</button></header>
    {tab === '管理' && <nav className="chip-nav" aria-label="管理機能">{adminSections.map(item => <button key={item} className={item === section ? 'active' : ''} onClick={() => setSection(item)}>{item}</button>)}</nav>}
    {tab === '月次' && <MonthlyActions month={month} setMonth={setMonth} reload={load} setError={setError} />}
    {tab === '管理' && section === '従業員' && <EmployeeCreate reload={load} />}
    {tab === '管理' && section === 'バックアップ' && <BackupActions reload={load} setError={setError} />}
    {tab === '管理' && section === '設定' && <SettingsPanel />}
    {error ? <Empty title="読み込みに失敗しました" text={error} action="再試行" onAction={load} error /> : loading ? <Loading label="読み込んでいます…" /> : <CardList kind={tab === '管理' ? section : tab} rows={rows} reload={load} setError={setError} />}
    {tab === '月次' && <p className="salary-note">給与見込みは30分丸めの参考値です。残業・休日・税・保険・控除は含みません。</p>}
    <nav className="bottom-tabs" aria-label="メインメニュー"><button onClick={home}><b>打刻</b></button>{(['勤怠', '月次', '管理'] as Tab[]).map(item => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}><b>{item}</b></button>)}</nav>
  </section>;
}
function downloadText(fileName: string, content: string, mimeType: string) { const url = URL.createObjectURL(new Blob([content], { type: mimeType })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
function MonthlyActions({ month, setMonth, reload, setError }: { month: string; setMonth: (value: string) => void; reload: () => Promise<void>; setError: (value: string) => void }) {
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState('');
  const csv = async () => { setBusy('csv'); setError(''); try { const result = await call('monthly', 'exportCsv', month); downloadText(result.fileName ?? `給与見込み-${month}.csv`, result.csv ?? '', result.mimeType ?? 'text/csv;charset=utf-8'); } catch (cause) { setError(cause instanceof Error ? cause.message : 'CSVを出力できませんでした。'); } finally { setBusy(''); } };
  const print = async () => { setBusy('print'); setError(''); try { await call('monthly', 'print', month); window.print(); } catch (cause) { setError(cause instanceof Error ? cause.message : '印刷を開始できませんでした。'); } finally { setBusy(''); } };
  const period = async (action: 'close' | 'reopen') => { if (!reason.trim()) return setError(`${action === 'close' ? '月締め' : '再開'}の理由を入力してください。`); const copy = action === 'close' ? `${month}を月締めします。締め後は打刻・修正できません。続けますか？` : `${month}を再開します。月次データが再び変更可能になります。続けますか？`; if (!confirm(copy)) return; setBusy(action); setError(''); try { await call('monthly', action, { month, reason: reason.trim(), requestId: requestId() }); setReason(''); await reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : '月次状態を変更できませんでした。'); } finally { setBusy(''); } };
  return <div className="monthly-tools"><div className="toolbar"><label>対象月<input type="month" value={month} onChange={e => setMonth(e.target.value)} /></label><button disabled={Boolean(busy)} onClick={() => void csv()}>{busy === 'csv' ? '作成中…' : 'CSV出力'}</button><button disabled={Boolean(busy)} onClick={() => void print()}>{busy === 'print' ? '準備中…' : '印刷'}</button></div><div className="period-panel"><label>処理理由<input value={reason} onChange={e => setReason(e.target.value)} placeholder="例：内容を確認済み" /></label><div><button className="primary" disabled={Boolean(busy)} onClick={() => void period('close')}>月締めする</button><button disabled={Boolean(busy)} onClick={() => void period('reopen')}>月締めを解除</button></div></div></div>;
}
function BackupActions({ reload, setError }: { reload: () => Promise<void>; setError: (value: string) => void }) {
  const [busy, setBusy] = useState(false);
  const create = async () => { setBusy(true); setError(''); try { const created = await call('backup', 'create', { kind: 'MANUAL', requestId: requestId() }); const file = created?.json ? { fileName: created.fileName, json: created.json } : await exportBackup(); downloadText(file.fileName || `勤怠バックアップ-${new Date().toISOString().slice(0, 10)}.json`, file.json, 'application/json;charset=utf-8'); await reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'バックアップを作成できませんでした。'); } finally { setBusy(false); } };
  const restore = async (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; if (!confirm(`「${file.name}」から復元します。現在のデータは置き換えられ、この操作は取り消せません。続けますか？`)) return; setBusy(true); setError(''); try { const result = await restoreBackupFile(file); if (result && 'ok' in result && !result.ok) throw new Error(result.message); await reload().catch(() => undefined); window.location.reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'バックアップを復元できませんでした。'); setBusy(false); } };
  return <div className="backup-actions"><button className="primary" disabled={busy} onClick={() => void create()}>{busy ? '処理しています…' : 'バックアップを作成・保存'}</button><label className={`file-button ${busy ? 'disabled' : ''}`}>バックアップファイルから復元<input type="file" accept="application/json,.json" disabled={busy} onChange={event => void restore(event)} /></label><p>作成したJSONファイルは「ファイル」アプリなど、このiPhone外にも保管してください。</p></div>;
}
function EmployeeCreate({ reload }: { reload: () => Promise<void> }) { const [name, setName] = useState(''); const [wage, setWage] = useState(''); const [busy, setBusy] = useState(false); const submit = async (e: FormEvent) => { e.preventDefault(); setBusy(true); try { await call('employees', 'create', { name, hourlyWage: Number(wage), requestId: requestId() }); setName(''); setWage(''); await reload(); } finally { setBusy(false); } }; return <details className="create-panel"><summary>従業員を追加</summary><form onSubmit={submit}><label>氏名<input value={name} maxLength={80} onChange={e => setName(e.target.value)} required /></label><label>時給（円）<input inputMode="numeric" value={wage} onChange={e => setWage(normalizeNumericInput(e.target.value))} required /></label><button className="primary" disabled={busy}>{busy ? '追加しています…' : '追加する'}</button></form></details> }
function CardList({ kind, rows, reload, setError }: { kind: string; rows: any[]; reload: () => Promise<void>; setError: (value: string) => void }) {
  if (!rows.length) return <Empty title={`${kind}のデータはありません`} text="条件を変えるか、データが登録されるまでお待ちください。" />;
  if (kind === '概要') { const item = rows[0] ?? {}; const metric = (value: any) => typeof value === 'number' ? value : value?.n ?? 0; const cards = [{ key: 'employees', title: '在籍従業員', value: metric(item.employees) }, { key: 'openShifts', title: '未退勤', value: metric(item.openShifts) }, { key: 'reviewShifts', title: '要確認', value: metric(item.reviewShifts) }, { key: 'latestBackup', title: '最終バックアップ', value: item.latestBackup ? display('created_at', item.latestBackup) : '未作成' }]; return <div className="summary-grid">{cards.map(card => <article key={card.key}><span>{card.title}</span><strong>{card.value}</strong></article>)}</div>; }
  const actEmployee = async (row: any, action: 'archive' | 'restore' | 'permanentlyDelete') => {
    if (action === 'archive' && !confirm(`「${row.name}」を削除しますか？ 30日以内は復元できます。`)) return;
    if (action === 'permanentlyDelete' && !confirm(`「${row.name}」を完全に削除しますか？ 勤怠履歴と時給履歴も削除され、取り消せません。`)) return;
    await call('employees', action, { id: row.id, requestId: requestId() }); await reload();
  };
  return <div className="card-list">{rows.map((row, index) => <article className="data-card" key={row.id ?? index}><div className="data-card-head"><strong>{row.name ?? row.employee_name ?? row.business_date ?? row.kind ?? row.file_name ?? `${kind} ${index + 1}`}</strong>{row.status && <span className="status-pill">{statusLabel(row.status)}</span>}</div><dl>{Object.entries(row).filter(([key, value]) => !['id', 'name', 'employee_name', 'status', 'display_order', 'version', 'pendingCorrection'].includes(key) && typeof value !== 'object').slice(0, 5).map(([key, value]) => <div key={key}><dt>{label(key)}</dt><dd>{display(key, value)}</dd></div>)}</dl>{kind === '従業員' && (row.status === 'ARCHIVED' ? <div className="card-actions"><button onClick={() => void actEmployee(row, 'restore')}>復元</button><button className="danger-button" onClick={() => void actEmployee(row, 'permanentlyDelete')}>完全に削除</button></div> : <EmployeeCardActions row={row} reload={reload} setError={setError} remove={() => void actEmployee(row, 'archive')} />)}{kind === '勤怠' && <CorrectionForm row={row} reload={reload} setError={setError} />}{kind === '承認' && <ApprovalForm row={row} reload={reload} setError={setError} />}{kind === 'バックアップ' && <StoredBackupActions row={row} setError={setError} />}</article>)}</div>;
}
function EmployeeCardActions({ row, reload, setError, remove }: { row: any; reload: () => Promise<void>; setError: (value: string) => void; remove: () => void }) { const [name, setName] = useState(row.name ?? ''); const [wage, setWage] = useState(String(row.hourly_wage ?? row.hourlyWage ?? '')); const [busy, setBusy] = useState(false); const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { await call('employees', 'update', { id: row.id, name: name.trim(), hourlyWage: Number(wage), requestId: requestId() }); await reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : '従業員情報を更新できませんでした。'); } finally { setBusy(false); } }; return <><details className="card-form"><summary>編集</summary><form onSubmit={submit}><label>氏名<input value={name} maxLength={80} onChange={event => setName(event.target.value)} required /></label><label>時給（円）<input inputMode="numeric" value={wage} onChange={event => setWage(normalizeNumericInput(event.target.value))} required /></label><button className="primary" disabled={busy}>{busy ? '更新しています…' : '変更を保存'}</button></form></details><div className="card-actions"><button onClick={remove}>削除</button></div></> }
function localDateTime(value: unknown) { if (typeof value !== 'number' || !Number.isFinite(value)) return ''; const date = new Date(value); const offset = date.getTimezoneOffset() * 60_000; return new Date(value - offset).toISOString().slice(0, 16); }
function CorrectionForm({ row, reload, setError }: { row: any; reload: () => Promise<void>; setError: (value: string) => void }) { const [start, setStart] = useState(localDateTime(row.clock_in)); const [end, setEnd] = useState(localDateTime(row.clock_out)); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); if (!row.clock_out) return <p className="card-hint">退勤後に時刻の訂正を申請できます。</p>; const submit = async (event: FormEvent) => { event.preventDefault(); const startAt = new Date(start).getTime(); const endAt = new Date(end).getTime(); if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) return setError('訂正する出勤・退勤時刻を確認してください。'); setBusy(true); setError(''); try { await call('attendance', 'proposeCorrection', { shiftId: row.id, startAt, endAt, reason: reason.trim(), requestId: requestId() }); setReason(''); await reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : '訂正を申請できませんでした。'); } finally { setBusy(false); } }; return <details className="card-form"><summary>{row.pendingCorrection ? '訂正申請あり' : '時刻を訂正申請'}</summary>{row.pendingCorrection ? <p className="card-hint">この勤務には承認待ちの訂正があります。</p> : <form onSubmit={submit}><label>出勤時刻<input type="datetime-local" value={start} onChange={event => setStart(event.target.value)} required /></label><label>退勤時刻<input type="datetime-local" value={end} onChange={event => setEnd(event.target.value)} required /></label><label>訂正理由<input value={reason} onChange={event => setReason(event.target.value)} maxLength={240} required /></label><button className="primary" disabled={busy}>{busy ? '申請しています…' : '訂正を申請'}</button></form>}</details> }
function ApprovalForm({ row, reload, setError }: { row: any; reload: () => Promise<void>; setError: (value: string) => void }) { const [decisionReason, setDecisionReason] = useState(''); const [exceptionReason, setExceptionReason] = useState(''); const [busy, setBusy] = useState(''); const decide = async (approve: boolean) => { if (!decisionReason.trim()) return setError(`${approve ? '承認' : '却下'}理由を入力してください。`); if (!confirm(`この訂正を${approve ? '承認' : '却下'}します。続けますか？`)) return; setBusy(approve ? 'approve' : 'reject'); setError(''); try { await call('attendance', 'decideCorrection', { id: row.pendingCorrection.id, approve, reason: decisionReason.trim(), requestId: requestId() }); await reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : '訂正を処理できませんでした。'); } finally { setBusy(''); } }; const exception = async () => { if (!exceptionReason.trim()) return setError('例外承認の理由を入力してください。'); if (!confirm('通常の計算条件から外れる勤務を例外として承認します。続けますか？')) return; setBusy('exception'); setError(''); try { await call('attendance', 'approveException', { shiftId: row.id, reason: exceptionReason.trim(), requestId: requestId() }); await reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : '例外承認できませんでした。'); } finally { setBusy(''); } }; const needsReview = row.calc_status === 'NEEDS_REVIEW' || row.calculation?.status === 'NEEDS_REVIEW'; return <div className="approval-stack">{row.pendingCorrection && <section className="approval-panel"><strong>訂正申請</strong><p>申請理由：{row.pendingCorrection.reason || '記載なし'}</p><p>{display('clock_in', row.pendingCorrection.start_at)} → {display('clock_out', row.pendingCorrection.end_at)}</p><label>判断理由<input value={decisionReason} onChange={event => setDecisionReason(event.target.value)} maxLength={240} /></label><div><button disabled={Boolean(busy)} onClick={() => void decide(false)}>却下</button><button className="primary" disabled={Boolean(busy)} onClick={() => void decide(true)}>承認</button></div></section>}{needsReview && <section className="approval-panel warning"><strong>計算の例外承認</strong><p>短時間勤務や長時間勤務など、通常計算できない勤務です。</p><label>承認理由<input value={exceptionReason} onChange={event => setExceptionReason(event.target.value)} maxLength={240} /></label><button className="primary" disabled={Boolean(busy)} onClick={() => void exception()}>{busy === 'exception' ? '承認しています…' : '例外として承認'}</button></section>}</div> }
function StoredBackupActions({ row, setError }: { row: any; setError: (value: string) => void }) { const [busy, setBusy] = useState(false); const verify = async () => { setBusy(true); setError(''); try { const result = await call('backup', 'verify', row.id); if (!result?.valid) throw new Error('バックアップの整合性を確認できませんでした。'); } catch (cause) { setError(cause instanceof Error ? cause.message : '整合性を確認できませんでした。'); } finally { setBusy(false); } }; const restore = async () => { if (!confirm(`「${row.file_name ?? 'このバックアップ'}」から復元します。現在のデータは置き換えられ、この操作は取り消せません。続けますか？`)) return; setBusy(true); setError(''); try { await call('backup', 'restore', { id: row.id, requestId: requestId() }); window.location.reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'バックアップを復元できませんでした。'); setBusy(false); } }; return <div className="card-actions"><button disabled={busy} onClick={() => void verify()}>整合性を確認</button><button className="danger-button" disabled={busy} onClick={() => void restore()}>{busy ? '処理中…' : '復元'}</button></div> }
function SettingsPanel() { const [oldPin, setOldPin] = useState(''); const [newPin, setNewPin] = useState(''); const [confirmPin, setConfirmPin] = useState(''); const [status, setStatus] = useState(''); const submit = async (e: FormEvent) => { e.preventDefault(); if (newPin.length !== 6 || newPin !== confirmPin) return setStatus('新しいPINを6桁で一致させてください。'); await call('adminAuth', 'changePin', { oldPin, newPin, requestId: requestId() }); setStatus('管理者PINを変更しました。'); setOldPin(''); setNewPin(''); setConfirmPin(''); }; return <details className="create-panel"><summary>管理者PINを変更</summary><form onSubmit={submit}>{[['現在のPIN', oldPin, setOldPin], ['新しいPIN', newPin, setNewPin], ['新しいPIN（確認）', confirmPin, setConfirmPin]].map(([title, value, setter]: any) => <label key={title}>{title}<input type="password" autoComplete={title === '現在のPIN' ? 'current-password' : 'new-password'} inputMode="numeric" maxLength={6} value={value} onChange={e => setter(normalizeNumericInput(e.target.value, 6))} /></label>)}{status && <p role="status">{status}</p>}<button className="primary">PINを変更する</button></form></details> }
function Loading({ label }: { label: string }) { return <div className="loading" role="status"><span className="spinner" />{label}</div> }
function Empty({ title, text, action, onAction, error = false }: { title: string; text: string; action?: string; onAction?: () => void; error?: boolean }) { return <div className={`empty-state ${error ? 'error' : ''}`}><strong>{title}</strong><p>{text}</p>{action && onAction && <button onClick={onAction}>{action}</button>}</div> }
const labels: Record<string, string> = { employees: '従業員数', openShifts: '勤務中', reviewShifts: '要確認', latestBackup: '最終バックアップ', hourly_wage: '時給', business_date: '勤務日', clock_in: '出勤', clock_out: '退勤', created_at: '日時', archived_at: '削除日時', restore_until: '復元期限', totalMinutes: '勤務分', roundedYen: '給与見込み', kind: '種類', result: '結果', file_name: 'ファイル' };
function label(key: string) { return labels[key] ?? key; }
function statusLabel(value: unknown) { return ({ ACTIVE: '在籍中', ARCHIVED: '削除済み', OPEN: '未退勤', CALCULATED: '計算済み', NEEDS_REVIEW: '要確認', SUCCESS: '完了', FAILED: '失敗', CLOSED: '月締め済み', PENDING: '承認待ち', APPROVED: '承認済み', REJECTED: '却下' } as Record<string, string>)[String(value)] ?? String(value); }
function display(key: string, value: any) { if (value == null) return '—'; if (typeof value === 'number' && (key.endsWith('_at') || key === 'clock_in' || key === 'clock_out')) return new Date(value).toLocaleString('ja-JP'); if (key.includes('Wage') || key.includes('Yen') || key === 'hourly_wage') return `${Number(value).toLocaleString('ja-JP')} 円`; if (key.includes('Minutes')) return `${Number(value).toLocaleString('ja-JP')} 分`; return String(value); }

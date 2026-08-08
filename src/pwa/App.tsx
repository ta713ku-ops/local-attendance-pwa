import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { normalizeNumericInput } from '../shared/input';
import type { ClockEmployeeDto, PwaAttendanceApi } from './pwa-api.types';
import { AdminApp } from './components/AdminApp';
import { Dialog, rememberDialogTrigger } from './components/Dialog';

type HomeEmployee = ClockEmployeeDto;
type View = 'clock' | 'state' | 'confirm' | 'done' | 'auth' | 'recovery' | 'admin';
const pwaApi = () => window.attendance as unknown as PwaAttendanceApi;
const requestId = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const unwrap = async <T,>(promise: Promise<{ ok: true; data: T } | { ok: false; message: string }>) => { const result = await promise; if (!result.ok) throw new Error(result.message); return result.data; };
const clockTime = (value?: number) => value ? new Date(value).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '—';

export default function App() {
  const [view, setView] = useState<View>('clock');
  const [employees, setEmployees] = useState<HomeEmployee[]>([]);
  const [selected, setSelected] = useState<HomeEmployee>();
  const [search, setSearch] = useState('');
  const [now, setNow] = useState(new Date());
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [updateReady, setUpdateReady] = useState(Boolean(window.__PWA_UPDATE_READY__));
  const [updateRegistration, setUpdateRegistration] = useState<ServiceWorkerRegistration>();
  const [updating, setUpdating] = useState(false);
  const updateRequested = useRef(false);
  const reloading = useRef(false);
  const loadHome = async () => { setLoading(true); setError(''); try { const data = await unwrap(pwaApi().clock.home()); setEmployees(data.employees); setConfigured(data.adminConfigured); } catch (cause) { setError(cause instanceof Error ? cause.message : '打刻画面を読み込めませんでした。'); } finally { setLoading(false); } };
  useEffect(() => { void loadHome(); const timer = window.setInterval(() => setNow(new Date()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const onUpdateReady = (event: Event) => {
      setUpdateRegistration((event as CustomEvent<ServiceWorkerRegistration>).detail);
      setUpdateReady(true);
    };
    const onControllerChange = () => {
      if (!updateRequested.current || reloading.current) return;
      reloading.current = true;
      window.location.reload();
    };
    window.addEventListener('attendance:update-ready', onUpdateReady);
    navigator.serviceWorker?.addEventListener('controllerchange', onControllerChange);
    if (window.__PWA_UPDATE_READY__) {
      void navigator.serviceWorker?.getRegistration().then(registration => {
        if (registration?.waiting) setUpdateRegistration(registration);
      });
    }
    return () => {
      window.removeEventListener('attendance:update-ready', onUpdateReady);
      navigator.serviceWorker?.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);
  useEffect(() => { if (!['state', 'confirm'].includes(view)) return; const timer = window.setTimeout(() => setView('clock'), 30000); return () => clearTimeout(timer); }, [view]);
  useEffect(() => { if (view !== 'done') return; const timer = window.setTimeout(() => { setView('clock'); void loadHome(); }, 3000); return () => clearTimeout(timer); }, [view]);
  const visible = useMemo(() => employees.filter(employee => employee.name.includes(search.trim())), [employees, search]);
  const choose = async (employee: HomeEmployee) => { setSelected(employee); setView('state'); setLoading(true); try { const state = await unwrap(pwaApi().clock.status(employee.id)); setSelected({ ...employee, status: state.status === 'WORKING' || state.status === 'LONG_SHIFT_WARNING' ? 'WORKING' : state.status === 'REENTRY_CONFIRMATION' ? 'CLOCKED_OUT_TODAY' : 'ACTIVE', startedAt: state.clockIn ?? undefined }); } catch (cause) { setError(cause instanceof Error ? cause.message : '勤務状態を確認できませんでした。'); } finally { setLoading(false); } };
  const save = async () => { if (!selected) return; setBusy(true); setError(''); try { if (selected.status === 'WORKING') await unwrap(pwaApi().clock.clockOut({ employeeId: selected.id, requestId: requestId() })); else await unwrap(pwaApi().clock.clockIn({ employeeId: selected.id, requestId: requestId(), reClockAcknowledged: selected.status === 'CLOCKED_OUT_TODAY' })); setView('done'); } catch (cause) { setError(cause instanceof Error ? cause.message : '打刻を保存できませんでした。'); } finally { setBusy(false); } };
  const applyUpdate = async () => {
    setUpdating(true);
    setError('');
    try {
      const registration = updateRegistration ?? await navigator.serviceWorker?.getRegistration();
      if (!registration?.waiting) throw new Error('更新の準備を確認できませんでした。通信状態を確認して、もう一度お試しください。');
      updateRequested.current = true;
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    } catch (cause) {
      updateRequested.current = false;
      setUpdating(false);
      setError(cause instanceof Error ? cause.message : '更新を開始できませんでした。');
    }
  };
  const lock = async () => { await pwaApi().adminAuth.lock(); setView('clock'); await loadHome(); };
  return <main className="pwa-shell" onClickCapture={event => { const target = event.target as Element; rememberDialogTrigger(target.closest<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')); }}>
    {error && <div className="notice error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="エラーを閉じる">×</button></div>}
    {updateReady && <aside className="update-banner" role="status" aria-live="polite" aria-label="アプリの更新">
      <p><strong>新しいバージョンがあります</strong><span>打刻を終えてから更新できます。</span></p>
      <div className="update-actions"><button className="update-now" disabled={updating} onClick={() => void applyUpdate()}>{updating ? '更新しています…' : '今すぐ更新'}</button><button disabled={updating} onClick={() => setUpdateReady(false)}>あとで</button></div>
    </aside>}
    {view === 'clock' && <ClockHome now={now} employees={visible} search={search} loading={loading} onSearch={setSearch} onChoose={choose} onAdmin={() => setView('auth')} retry={loadHome} />}
    {view === 'state' && <Flow title={`${selected?.name ?? ''}さんの勤務状態`} back={() => setView('clock')}><div className="status-card"><strong>{loading ? '確認しています…' : selected?.status === 'WORKING' ? '勤務中です' : selected?.status === 'CLOCKED_OUT_TODAY' ? '本日は退勤済みです' : '現在は出勤していません'}</strong>{selected?.status === 'WORKING' && <span>出勤時刻：{clockTime(selected.startedAt)}</span>}</div><button className="primary action-button" disabled={loading} onClick={() => setView('confirm')}>次へ</button></Flow>}
    {view === 'confirm' && <Flow title={`${selected?.status === 'WORKING' ? '退勤' : '出勤'}を確定しますか？`} back={() => setView('state')}><div className="status-card"><strong>{selected?.name}さん</strong><span>{selected?.status === 'CLOCKED_OUT_TODAY' ? '本日2回目の出勤として記録します。' : `${clockTime(Date.now())} に記録します。`}</span></div><button className="primary action-button" disabled={busy} onClick={() => void save()}>{busy ? '保存しています…' : '確定する'}</button></Flow>}
    {view === 'done' && <section className="flow done"><div className="check">✓</div><h1>{selected?.status === 'WORKING' ? '退勤を記録しました' : '出勤を記録しました'}</h1><p>{selected?.name}さん、{selected?.status === 'WORKING' ? 'おつかれさまです。' : 'よろしくお願いします。'}</p></section>}
    {view === 'auth' && <AdminAuth configured={configured} back={() => setView('clock')} open={() => setView('admin')} recover={() => setView('recovery')} onRecovery={setRecoveryCode} />}
    {view === 'recovery' && <Recovery back={() => setView('auth')} onRecovery={setRecoveryCode} />}
    {view === 'admin' && <AdminApp api={pwaApi()} onLock={() => void lock()} />}
    {recoveryCode && <Dialog title="回復コードを保管してください" closeLabel="保存しました" onClose={() => { setRecoveryCode(''); setView('admin'); }}><p>このコードは再表示できません。紙など安全な場所に控えてください。</p><code className="recovery-code">{recoveryCode}</code></Dialog>}
  </main>;
}

function ClockHome({ now, employees, search, loading, onSearch, onChoose, onAdmin, retry }: { now: Date; employees: HomeEmployee[]; search: string; loading: boolean; onSearch: (value: string) => void; onChoose: (employee: HomeEmployee) => void; onAdmin: () => void; retry: () => Promise<void> }) { return <section className="clock-page"><header className="clock-head"><h1>打刻</h1><p className="today">{now.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' })}</p><output className="clock-time">{clockTime(now.getTime())}</output></header><div className="clock-body"><h2>お名前を選んでください</h2><label className="search"><span className="sr-only">氏名を検索</span><input value={search} onChange={event => onSearch(event.target.value)} placeholder="氏名を検索" /></label>{loading ? <Loading /> : employees.length ? <div className="employee-grid">{employees.map(employee => <button className="employee-card" key={employee.id} onClick={() => onChoose(employee)}><span>{employee.name}</span><small>{employee.status === 'WORKING' ? '勤務中' : employee.status === 'CLOCKED_OUT_TODAY' ? '本日退勤済み' : 'タップして打刻'}</small></button>)}</div> : <Empty title="表示できる従業員がいません" action={() => void retry()} />}</div><footer className="clock-footer"><button className="link-button" onClick={onAdmin}>管理者メニュー</button></footer></section>; }
function Flow({ title, back, children }: { title: string; back: () => void; children: React.ReactNode }) { return <section className="flow"><button className="back" onClick={back}>‹ 打刻へ戻る</button><h1>{title}</h1>{children}<small className="return">30秒操作がない場合は打刻ホームへ戻ります。</small></section>; }
function AdminAuth({ configured, back, open, recover, onRecovery }: { configured: boolean; back: () => void; open: () => void; recover: () => void; onRecovery: (code: string) => void }) { const [pin, setPin] = useState(''); const [confirmation, setConfirmation] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const submit = async (event: FormEvent) => { event.preventDefault(); if (pin.length !== 6 || (!configured && pin !== confirmation)) return setError('6桁のPINを正しく入力してください。'); setBusy(true); try { if (configured) await unwrap(pwaApi().adminAuth.verify({ pin, requestId: requestId() })); else { const result = await unwrap(pwaApi().adminAuth.setup({ pin, requestId: requestId() })); onRecovery(result.recoveryCode); return; } open(); } catch (cause) { setError(cause instanceof Error ? cause.message : '認証できませんでした。'); } finally { setBusy(false); } }; return <Flow title={configured ? '管理者PINを入力' : '管理者PINを設定'} back={back}><form className="stack-form" onSubmit={submit}><PinField label="PIN（6桁）" value={pin} setValue={setPin} />{!configured && <PinField label="PIN（確認）" value={confirmation} setValue={setConfirmation} />}{error && <p className="form-error" role="alert">{error}</p>}<button className="primary action-button" disabled={busy}>{busy ? '確認しています…' : '認証する'}</button>{configured && <button type="button" className="link-button" onClick={recover}>PINを忘れた場合</button>}</form></Flow>; }
function Recovery({ back, onRecovery }: { back: () => void; onRecovery: (code: string) => void }) { const [code, setCode] = useState(''); const [pin, setPin] = useState(''); const [confirmation, setConfirmation] = useState(''); const [error, setError] = useState(''); const submit = async (event: FormEvent) => { event.preventDefault(); if (pin.length !== 6 || pin !== confirmation) return setError('新しいPINを6桁で一致させてください。'); try { const result = await unwrap(pwaApi().adminAuth.resetWithRecovery({ recoveryCode: code.trim(), newPin: pin, requestId: requestId() })); onRecovery(result.recoveryCode); } catch (cause) { setError(cause instanceof Error ? cause.message : '再設定できませんでした。'); } }; return <Flow title="管理者PINを再設定" back={back}><form className="stack-form" onSubmit={submit}><label>回復コード<input type="password" value={code} onChange={event => setCode(event.target.value)} /></label><PinField label="新しいPIN" value={pin} setValue={setPin} /><PinField label="新しいPIN（確認）" value={confirmation} setValue={setConfirmation} />{error && <p className="form-error">{error}</p>}<button className="primary action-button">PINを再設定する</button></form></Flow>; }
function PinField({ label, value, setValue }: { label: string; value: string; setValue: (value: string) => void }) { return <label>{label}<input type="password" inputMode="numeric" pattern="[0-9０-９]*" maxLength={6} value={value} onChange={event => setValue(normalizeNumericInput(event.target.value, 6))} /></label>; }
export function Loading() { return <div className="loading" role="status"><span className="spinner" />読み込んでいます…</div>; }
export function Empty({ title, action }: { title: string; action?: () => void }) { return <div className="empty-state"><strong>{title}</strong>{action && <button onClick={action}>再試行</button>}</div>; }

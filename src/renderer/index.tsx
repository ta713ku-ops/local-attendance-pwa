import React, { FormEvent, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AttendanceApi } from '../shared/api';
import { normalizeNumericInput } from '../shared/input';
import './styles.css';
import './admin.css';

type Employee = { id: string; name: string; hourlyWage?: number; status?: string; startedAt?: string };
type Screen = 'home' | 'state' | 'confirm' | 'done' | 'pin-setup' | 'pin' | 'pin-recovery' | 'admin';
type Notice = { kind: 'error' | 'warning' | 'success'; text: string } | null;
const desktopBridgeAvailable = typeof (window as Window & { attendance?: AttendanceApi }).attendance === 'object';
const CALL = async (group: string, action: string, payload?: any): Promise<any> => {
  const api = (window as Window & { attendance?: AttendanceApi }).attendance as any;
  const fn = api?.[group]?.[action];
  if (typeof fn !== 'function') throw new Error('アプリとの通信に接続できません。アプリを再起動しても続く場合は管理者へ連絡してください。');
  const result = await fn(group === 'clock' && action === 'status' ? payload.employeeId : payload);
  if (result && result.ok === false) throw new Error(result.message ?? '操作を完了できませんでした。');
  if (result?.ok === true && result.backupWarning) {
    return typeof result.data === 'object' && result.data !== null
      ? { ...result.data, kind: 'saved_backup_failed', backupWarning: result.backupWarning }
      : { value: result.data, kind: 'saved_backup_failed', backupWarning: result.backupWarning };
  }
  return result?.data ?? result;
};
const requestId = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const yen = (value?: number) => typeof value === 'number' ? `${value.toLocaleString('ja-JP')} 円` : '—';
const Icon = ({ name }: { name: 'clock' | 'shield' | 'download' | 'print' | 'back' | 'logout' }) => {
  const paths: Record<string, React.ReactNode> = {
    clock: <><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></>, shield: <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z"/>,
    download: <><path d="M12 3v11"/><path d="m8 10 4 4 4-4"/><path d="M4 20h16"/></>, print: <><path d="M6 9V3h12v6"/><rect x="4" y="9" width="16" height="9" rx="1"/><path d="M7 18h10v3H7z"/></>,
    back: <><path d="m15 18-6-6 6-6"/><path d="M9 12h11"/></>, logout: <><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M13 5h6v14h-6"/></>
  };
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
};

const salaryNote = '給与見込みは、30分丸めの基本賃金と深夜割増のみの参考値です。残業・休日・税・保険・控除は含みません。';
const nav = ['ダッシュボード', '従業員', '勤怠', '承認', '月次', '操作ログ', 'バックアップ', '設定'];

function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selected, setSelected] = useState<Employee | null>(null);
  const [activeNav, setActiveNav] = useState('ダッシュボード');
  const [pin, setPin] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [adminReady, setAdminReady] = useState<boolean | null>(null);
  const [requiresInitialPinChange, setRequiresInitialPinChange] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [adminLocked, setAdminLocked] = useState(false);
  const [now, setNow] = useState(new Date());

  const loadHome = async () => {
    setLoading(true); setNotice(null);
    try {
      const result = await CALL('clock', 'home');
      const values = result?.employees ?? result ?? [];
      setEmployees(Array.isArray(values) ? values : []);
      setAdminReady(result?.adminConfigured ?? true);
      setRequiresInitialPinChange(result?.requiresInitialPinChange === true);
    } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : '打刻ホームを取得できませんでした。' }); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    if (!desktopBridgeAvailable) { setLoading(false); return; }
    void loadHome();
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (screen !== 'state' && screen !== 'confirm') return;
    const id = window.setTimeout(() => { setSelected(null); setScreen('home'); }, 30000);
    return () => clearTimeout(id);
  }, [screen]);
  useEffect(() => {
    if (screen !== 'admin') return;
    let timer = 0;
    const reset = () => { window.clearTimeout(timer); timer = window.setTimeout(() => { setAdminLocked(true); void window.attendance.adminAuth.lock(); setNotice({ kind: 'warning', text: '5分間操作がなかったため、管理画面をロックしました。入力内容は保持されています。' }); }, 5 * 60_000); };
    reset(); ['pointerdown', 'keydown', 'focusin'].forEach(event => window.addEventListener(event, reset));
    return () => { window.clearTimeout(timer); ['pointerdown', 'keydown', 'focusin'].forEach(event => window.removeEventListener(event, reset)); };
  }, [screen]);
  useEffect(() => {
    if (screen !== 'done') return;
    const id = window.setTimeout(() => { setSelected(null); setScreen('home'); void loadHome(); }, 5000);
    return () => clearTimeout(id);
  }, [screen]);

  const selectEmployee = async (employee: Employee) => {
    setSelected(employee); setScreen('state'); setLoading(true); setNotice(null);
    try {
      const state = await CALL('clock', 'status', { employeeId: employee.id });
      const working = Boolean(state?.clock_in) && state.clock_out == null;
      const completedToday = state?.clock_out && state?.business_date === new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
      setSelected({ ...employee, status: working ? 'WORKING' : completedToday ? 'CLOCKED_OUT_TODAY' : 'OFF', startedAt: state?.clock_in ? new Date(state.clock_in).toISOString() : undefined });
    } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : '勤務状態を確認できませんでした。' }); }
    finally { setLoading(false); }
  };
  const isClockOut = selected?.status === 'WORKING' || selected?.status === 'CLOCKED_IN';
  const isReclock = selected?.status === 'CLOCKED_OUT_TODAY' || selected?.status === 'COMPLETED_TODAY';
  const submitClock = async () => {
    if (!selected) return; setSubmitting(true); setNotice(null);
    try {
      const action = isClockOut ? 'clockOut' : 'clockIn';
      const result = await CALL('clock', action, { employeeId: selected.id, requestId: requestId(), reClockAcknowledged: isReclock });
      if (result?.kind === 'saved_backup_failed') setNotice({ kind: 'warning', text: '打刻は保存済みですが、バックアップに失敗しました。管理者へ連絡してください。' });
      setScreen('done');
    } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : '打刻は保存されていません。もう一度お試しください。' }); }
    finally { setSubmitting(false); }
  };
  const authenticate = async (event: FormEvent) => {
    event.preventDefault(); if (pin.length !== 6) { setNotice({ kind: 'error', text: 'PINは6桁の数字で入力してください。' }); return; }
    setSubmitting(true); setNotice(null);
    try {
      const result = await CALL('adminAuth', screen === 'pin-setup' ? 'setup' : 'verify', { pin, requestId: requestId() });
      if (result?.recoveryCode) setRecoveryCode(result.recoveryCode);
      if (result?.requiresInitialPinChange) { setActiveNav('設定'); setNotice({ kind: 'warning', text: '初期PINでログインしました。設定から管理者PINを変更してください。' }); }
      setPin(''); setScreen('admin');
    }
    catch (error) {
      const message = error instanceof Error ? error.message : 'PINを確認できませんでした。';
      if (screen === 'pin' && message.includes('初期設定')) { setScreen('pin-setup'); setNotice({ kind: 'warning', text: '管理者が未設定です。PINを設定してください。' }); }
      else setNotice({ kind: 'error', text: message });
    }
    finally { setSubmitting(false); }
  };
  const openAdmin = () => setScreen(adminReady === false ? 'pin-setup' : 'pin');
  const unlockAdmin = async (event: FormEvent) => {
    event.preventDefault();
    if (pin.length !== 6) { setNotice({ kind: 'error', text: 'PINは6桁の数字で入力してください。' }); return; }
    setSubmitting(true);
    try {
      await CALL('adminAuth', 'verify', { pin, requestId: requestId() });
      setPin(''); setAdminLocked(false); setNotice({ kind: 'success', text: '管理画面のロックを解除しました。' });
    } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'PINを確認できませんでした。' }); }
    finally { setSubmitting(false); }
  };
  if (!desktopBridgeAvailable) return <BrowserUnsupported />;
  return <main className={`app-shell screen-${screen}`}>
    {notice && <div className={`notice notice-${notice.kind}`} role="alert"><strong>{notice.kind === 'error' ? '操作できません' : notice.kind === 'warning' ? '要確認' : '完了'}</strong><span>{notice.text}</span><button aria-label="通知を閉じる" onClick={() => setNotice(null)}>×</button></div>}
    {screen === 'home' && <ClockHome now={now} employees={employees} loading={loading} onSelect={selectEmployee} onAdmin={openAdmin} onReload={loadHome} />}
    {screen === 'state' && <EmployeeState employee={selected} loading={loading} onBack={() => setScreen('home')} onNext={() => setScreen('confirm')} />}
    {screen === 'confirm' && <Confirm employee={selected} clockOut={isClockOut} reclock={isReclock} busy={submitting} onBack={() => setScreen('state')} onSubmit={submitClock} />}
    {screen === 'done' && <Done employee={selected} clockOut={isClockOut} />}
    {(screen === 'pin' || screen === 'pin-setup') && <PinScreen setup={screen === 'pin-setup'} initialPin={screen === 'pin' && requiresInitialPinChange} pin={pin} setPin={setPin} busy={submitting} onBack={() => setScreen('home')} onRecover={() => setScreen('pin-recovery')} onSubmit={authenticate} />}
    {screen === 'pin-recovery' && <PinRecoveryScreen onBack={() => setScreen('pin')} onRecovered={(code) => { setRecoveryCode(code); setScreen('admin'); }} />}
    {screen === 'admin' && <Admin active={activeNav} setActive={setActiveNav} onHome={() => { setScreen('home'); void loadHome(); }} />}
    {screen === 'admin' && adminLocked && <div className="modal-backdrop"><section className="recovery-card" role="dialog" aria-modal="true" aria-labelledby="unlock-title"><p className="eyebrow">SESSION LOCKED</p><h2 id="unlock-title">管理画面はロックされています</h2><p>入力内容は保持されています。再開するには管理者PINを入力してください。</p><form onSubmit={unlockAdmin}><label htmlFor="unlock-pin">PIN（6桁）</label><input id="unlock-pin" inputMode="numeric" pattern="[0-9０-９]*" autoFocus maxLength={6} value={pin} onChange={event => setPin(normalizeNumericInput(event.target.value, 6))}/><button className="button primary wide" type="submit" disabled={submitting}>{submitting ? '確認しています…' : 'ロックを解除する'}</button></form></section></div>}
    {recoveryCode && <div className="modal-backdrop"><section className="recovery-card" role="dialog" aria-modal="true" aria-labelledby="recovery-title"><p className="eyebrow">ONE-TIME DISPLAY</p><h2 id="recovery-title">回復コードを安全な場所に保管してください</h2><p>このコードは再表示できません。PINを忘れた場合の再設定に必要です。</p><code>{recoveryCode}</code><button className="button primary wide" onClick={() => setRecoveryCode(null)}>確認して保管しました</button></section></div>}
  </main>;
}

function BrowserUnsupported() { return <main className="browser-unsupported"><section className="auth-card" role="alert" aria-labelledby="browser-title"><Icon name="shield"/><p className="eyebrow">DESKTOP APP REQUIRED</p><h1 id="browser-title">Safariでは操作できません</h1><p>この画面は勤怠データを保存するElectronアプリ専用です。Safariのタブを閉じて、起動済みの「ローカル勤怠・給与見込み管理」アプリを使用してください。</p><div className="browser-help"><strong>開発環境での起動方法</strong><code>npm start</code></div></section></main> }

function ClockHome({ now, employees, loading, onSelect, onAdmin, onReload }: any) { return <section className="clock-home" aria-labelledby="clock-title">
  <header className="clock-header"><div><p className="eyebrow">LOCAL ATTENDANCE</p><h1 id="clock-title">打刻</h1></div><div className="clock-datetime" aria-live="polite"><p className="date">{now.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })}</p><div className="digital-time">{now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div></div></header>
  <div className="clock-content"><p className="instruction">お名前を選んでください</p>{loading ? <div className="panel loading"><span className="spinner"/>従業員を読み込んでいます…</div> : employees.length ? <div className="employee-grid">{employees.map((e: Employee) => <button className="employee-button" key={e.id} onClick={() => onSelect(e)}><span title={e.name}>{e.name}</span></button>)}</div> : <div className="panel empty"><h2>表示できる従業員がいません</h2><p>管理者画面から従業員を登録すると、ここに表示されます。</p><button className="button secondary" onClick={onReload}>再読み込み</button></div>}</div>
  <footer className="clock-footer"><button className="text-button" onClick={onAdmin}><Icon name="shield"/>管理者メニュー</button><span>打刻後の内容は管理者画面で確認できます。</span></footer>
</section> }
function EmployeeState({ employee, loading, onBack, onNext }: any) { return <section className="flow-card"><button className="back-button" onClick={onBack}><Icon name="back"/>戻る</button><p className="eyebrow">STEP 1 / 2</p><h1>{employee?.name ?? '従業員'}さんの勤務状態</h1>{loading ? <div className="panel loading"><span className="spinner"/>確認しています…</div> : <><div className="state-panel"><Icon name="clock"/><div><strong>{employee?.status === 'WORKING' || employee?.status === 'CLOCKED_IN' ? '勤務中です' : employee?.status === 'CLOCKED_OUT_TODAY' ? '本日は退勤済みです' : '現在は出勤していません'}</strong><p>{employee?.startedAt ? `出勤時刻：${new Date(employee.startedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}` : '出勤すると、ここに勤務状況が表示されます。'}</p></div></div><button className="button primary wide" onClick={onNext}>{employee?.status === 'WORKING' || employee?.status === 'CLOCKED_IN' ? '退勤を確認する' : '出勤を確認する'}</button><p className="auto-return">30秒操作がない場合は打刻ホームへ戻ります。</p></>}</section> }
function Confirm({ employee, clockOut, reclock, busy, onBack, onSubmit }: any) { return <section className="flow-card"><button className="back-button" onClick={onBack}><Icon name="back"/>戻る</button><p className="eyebrow">STEP 2 / 2</p><h1>{clockOut ? '退勤を確定しますか？' : '出勤を確定しますか？'}</h1><div className={reclock ? 'state-panel warning-panel' : 'state-panel'}><Icon name={clockOut ? 'clock' : 'shield'}/><div><strong>{employee?.name}さん</strong><p>{reclock ? '本日はすでに退勤済みです。再出勤として記録します。' : `${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} に${clockOut ? '退勤' : '出勤'}を記録します。`}</p></div></div>{reclock && <p className="warning-copy">再出勤の記録が追加されます。時刻を確認してから確定してください。</p>}<button className="button primary wide" disabled={busy} onClick={onSubmit}>{busy ? '保存しています…' : `${clockOut ? '退勤' : '出勤'}を確定する`}</button><p className="auto-return">30秒操作がない場合は打刻ホームへ戻ります。</p></section> }
function Done({ employee, clockOut }: any) { return <section className="flow-card done-card" aria-live="polite"><div className="done-mark">✓</div><p className="eyebrow">SAVED</p><h1>{clockOut ? '退勤を記録しました' : '出勤を記録しました'}</h1><p>{employee?.name}さん、おつかれさまです。</p><p className="auto-return">5秒後に打刻ホームへ戻ります。</p></section> }
function PinScreen({ setup, initialPin, pin, setPin, busy, onBack, onRecover, onSubmit }: any) { return <section className="auth-card"><button className="back-button" onClick={onBack}><Icon name="back"/>打刻へ戻る</button><Icon name="shield"/><p className="eyebrow">ADMINISTRATOR</p><h1>{setup ? '管理者PINを設定' : '管理者PINを入力'}</h1><p>{setup ? '6桁の数字を設定してください。回復コードは設定後に一度だけ表示されます。' : '管理者メニューを開くにはPINが必要です。'}</p>{initialPin && <p className="initial-pin-note"><strong>初期PIN：123456</strong><span>ログイン後、設定画面で変更してください。</span></p>}<form onSubmit={onSubmit}><label htmlFor="pin">PIN（6桁）</label><input id="pin" inputMode="numeric" pattern="[0-9０-９]*" autoFocus maxLength={6} value={pin} onChange={e => setPin(normalizeNumericInput(e.target.value, 6))} aria-describedby="pin-help"/><p id="pin-help" className="field-help">ローマ字入力中でも、半角・全角どちらの数字でも入力できます。</p><button className="button primary wide" type="submit" disabled={busy}>{busy ? '確認しています…' : setup ? 'PINを設定する' : '認証する'}</button>{!setup && <button className="text-button auth-recovery-link" type="button" onClick={onRecover}>PINを忘れた場合</button>}</form></section> }

function PinRecoveryScreen({ onBack, onRecovered }: { onBack: () => void; onRecovered: (recoveryCode: string) => void }) {
  const [recoveryCode, setRecoveryCode] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    if (newPin.length !== 6) { setError('新しいPINは6桁で入力してください。'); return; }
    if (newPin !== confirmation) { setError('新しいPINと確認入力が一致しません。'); return; }
    setBusy(true);
    try {
      const result = await CALL('adminAuth', 'resetWithRecovery', { recoveryCode: recoveryCode.trim(), newPin, requestId: requestId() });
      onRecovered(result.recoveryCode);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'PINを再設定できませんでした。'); }
    finally { setBusy(false); }
  };
  return <section className="auth-card"><button className="back-button" onClick={onBack}><Icon name="back"/>PIN入力へ戻る</button><Icon name="shield"/><p className="eyebrow">PIN RECOVERY</p><h1>管理者PINを再設定</h1><p>初回設定時に保管した回復コードと、新しい6桁のPINを入力してください。</p><form onSubmit={submit}>{error && <p className="form-error" role="alert">{error}</p>}<label htmlFor="recovery-code">回復コード</label><input id="recovery-code" className="code-input" autoComplete="off" value={recoveryCode} onChange={event => setRecoveryCode(event.target.value)} required/><label htmlFor="recovery-new-pin">新しいPIN（6桁）</label><input id="recovery-new-pin" inputMode="numeric" pattern="[0-9０-９]*" maxLength={6} value={newPin} onChange={event => setNewPin(normalizeNumericInput(event.target.value, 6))} required/><label htmlFor="recovery-confirm-pin">新しいPIN（確認）</label><input id="recovery-confirm-pin" inputMode="numeric" pattern="[0-9０-９]*" maxLength={6} value={confirmation} onChange={event => setConfirmation(normalizeNumericInput(event.target.value, 6))} required/><button className="button primary wide" type="submit" disabled={busy}>{busy ? '再設定しています…' : 'PINを再設定する'}</button></form></section>;
}
function Admin({ active, setActive, onHome }: any) {
  const [data, setData] = useState<any[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(''), [name, setName] = useState(''), [wage, setWage] = useState(''), [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const source: Record<string, [string, string]> = { 'ダッシュボード': ['operations', 'dashboard'], '従業員': ['employees', 'list'], '勤怠': ['attendance', 'list'], '承認': ['attendance', 'list'], '月次': ['monthly', 'detail'], '操作ログ': ['operations', 'logs'], 'バックアップ': ['backup', 'list'], '設定': ['settings', 'get'] };
  const load = async () => { setLoading(true); setError(''); try { const [group, action] = source[active]; const argument = active === '月次' ? month : active === '従業員' ? true : undefined; const response = await CALL(group, action, argument); const values = response?.items ?? response; setData(Array.isArray(values) ? values : values == null ? [] : [values]); } catch (e) { setError(e instanceof Error ? e.message : 'データを取得できませんでした。'); } finally { setLoading(false); } };
  useEffect(() => { void load(); }, [active, month]);
  const createEmployee = async (e: FormEvent) => { e.preventDefault(); try { await CALL('employees', 'create', { name, hourlyWage: Number(wage), requestId: requestId() }); setName(''); setWage(''); await load(); } catch (e) { setError(e instanceof Error ? e.message : '従業員を追加できませんでした。'); } };
  const archive = async (id: string, restore = false) => { if (!restore && !window.confirm('この従業員を削除しますか？ 30日以内であれば、この一覧から復元できます。')) return; try { await CALL('employees', restore ? 'restore' : 'archive', { id, requestId: requestId() }); await load(); } catch (e) { setError(e instanceof Error ? e.message : '操作できませんでした。'); } };
  const permanentlyDelete = async (id: string, employeeName: string) => {
    if (!window.confirm(`「${employeeName}」を完全に削除しますか？\n\n勤怠履歴と時給履歴も削除され、この操作は取り消せません。`)) return;
    try { await CALL('employees', 'permanentlyDelete', { id, requestId: requestId() }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : '完全に削除できませんでした。'); }
  };
  const run = async (group:string, action:string, payload?:any) => { try { await CALL(group, action, payload); await load(); } catch (e) { setError(e instanceof Error ? e.message : '操作できませんでした。'); } };
  return <section className="admin-layout"><aside className="sidebar"><div className="brand"><span>勤</span><div>勤怠・給与見込み<small>LOCAL DESKTOP</small></div></div><nav aria-label="管理メニュー">{nav.map(item => <button key={item} className={active === item ? 'active' : ''} onClick={() => setActive(item)}>{item}</button>)}</nav><button className="home-link" onClick={onHome}><Icon name="logout"/>打刻ホームへ</button></aside><div className="admin-main"><header className="admin-header"><div><p className="eyebrow">ADMINISTRATION</p><h1>{active}</h1></div>{active === '月次' && <div className="header-actions"><button className="button secondary" onClick={() => run('monthly','exportCsv', month)}><Icon name="download"/>CSV出力</button><button className="button secondary" onClick={() => run('monthly','print', month)}><Icon name="print"/>印刷</button></div>}</header>{active === '従業員' && <form className="inline-form" onSubmit={createEmployee}><input aria-label="氏名" placeholder="氏名" value={name} onChange={e=>setName(e.target.value)} required maxLength={80}/><input aria-label="時給" placeholder="時給（円）" value={wage} onChange={e=>setWage(normalizeNumericInput(e.target.value))} required/><button className="button primary">従業員を追加</button></form>}{active === '月次' && <label className="month-select">対象月 <input type="month" value={month} onChange={e=>setMonth(e.target.value)}/></label>}{active === 'バックアップ' && <button className="button primary" onClick={()=>run('backup','create',{kind:'MANUAL',requestId:requestId()})}>手動バックアップを作成</button>}{active === '設定' && <PinChangePanel/>}{error ? <div className="panel error-state" role="alert"><strong>読み込みに失敗しました</strong><p>{error}</p><button className="button secondary" onClick={load}>再試行</button></div> : loading ? <div className="panel loading"><span className="spinner"/>読み込んでいます…</div> : <DataView title={active} rows={data} onArchive={archive} onPermanentlyDelete={permanentlyDelete}/>}<p className="salary-note">{salaryNote}</p></div></section>
}

function PinChangePanel() {
  const [oldPin, setOldPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [status, setStatus] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setStatus(null);
    if (oldPin.length !== 6 || newPin.length !== 6) { setStatus({ kind: 'error', text: '現在のPINと新しいPINを6桁で入力してください。' }); return; }
    if (newPin !== confirmation) { setStatus({ kind: 'error', text: '新しいPINと確認入力が一致しません。' }); return; }
    setBusy(true);
    try {
      await CALL('adminAuth', 'changePin', { oldPin, newPin, requestId: requestId() });
      setOldPin(''); setNewPin(''); setConfirmation('');
      setStatus({ kind: 'success', text: '管理者PINを変更しました。' });
    } catch (cause) { setStatus({ kind: 'error', text: cause instanceof Error ? cause.message : 'PINを変更できませんでした。' }); }
    finally { setBusy(false); }
  };
  return <section className="admin-panel security-panel" aria-labelledby="pin-change-title"><p className="eyebrow">SECURITY</p><h2 id="pin-change-title">管理者PINを変更</h2><p>現在のPINを確認してから、新しい6桁のPINへ変更します。</p>{status && <p className={`form-status ${status.kind}`} role="status">{status.text}</p>}<form onSubmit={submit}><label className="pin-field" htmlFor="old-pin"><span>現在のPIN</span><input id="old-pin" inputMode="numeric" pattern="[0-9０-９]*" maxLength={6} value={oldPin} onChange={event => setOldPin(normalizeNumericInput(event.target.value, 6))} required/></label><label className="pin-field" htmlFor="new-pin"><span>新しいPIN</span><input id="new-pin" inputMode="numeric" pattern="[0-9０-９]*" maxLength={6} value={newPin} onChange={event => setNewPin(normalizeNumericInput(event.target.value, 6))} required/></label><label className="pin-field" htmlFor="confirm-pin"><span>新しいPIN（確認）</span><input id="confirm-pin" inputMode="numeric" pattern="[0-9０-９]*" maxLength={6} value={confirmation} onChange={event => setConfirmation(normalizeNumericInput(event.target.value, 6))} required/></label><button className="button primary" type="submit" disabled={busy}>{busy ? '変更しています…' : 'PINを変更する'}</button></form></section>;
}
function DataView({ title, rows, onArchive, onPermanentlyDelete }: any) {
  if (!rows.length) return <div className="admin-panel empty compact"><p>{title}のデータはありません。</p></div>;
  const preferred: Record<string, string[]> = {
    'ダッシュボード': ['employees', 'openShifts', 'reviewShifts', 'latestBackup'],
    '従業員': ['name', 'status', 'hourly_wage', 'archived_at', 'restore_until'],
    '勤怠': ['employee_name', 'business_date', 'clock_in', 'clock_out', 'calc_status', 'calculation'],
    '承認': ['employee_name', 'business_date', 'calc_status', 'calculation'],
    '月次': ['name', 'totalMinutes', 'regularMinutes', 'nightMinutes', 'roundedYen'],
    '操作ログ': ['created_at', 'kind', 'target_id', 'result'],
    'バックアップ': ['created_at', 'kind', 'status', 'file_name', 'size'],
    '設定': ['key', 'value'],
  };
  const labels: Record<string, string> = { employees: '従業員数', openShifts: '未退勤', reviewShifts: '要確認', latestBackup: '最終バックアップ', name: '氏名', employee_name: '氏名', status: '状態', hourly_wage: '時給', archived_at: '削除日時', restore_until: '復元期限', business_date: '勤務日', clock_in: '元出勤', clock_out: '元退勤', calc_status: '計算状態', calculation: '計算結果', totalMinutes: '勤務分', regularMinutes: '通常分', nightMinutes: '深夜分', roundedYen: '給与見込み', created_at: '操作日時', kind: '種類', target_id: '対象', result: '結果', file_name: 'ファイル', size: 'サイズ', key: '設定', value: '値' };
  const keys = (preferred[title] ?? Object.keys(rows[0])).filter(key => key in rows[0]).slice(0, 6);
  const display = (key: string, value: any) => {
    if (value == null) return '—';
    if (key === 'status') return value === 'ARCHIVED' ? '削除済み' : value === 'ACTIVE' ? '在籍' : String(value);
    if (key === 'roundedYen' || key === 'hourly_wage') return yen(Number(value));
    if (['totalMinutes', 'regularMinutes', 'nightMinutes'].includes(key)) return `${Number(value).toLocaleString('ja-JP')} 分`;
    if (['clock_in', 'clock_out', 'created_at', 'archived_at', 'restore_until'].includes(key) && typeof value === 'number') return new Date(value).toLocaleString('ja-JP');
    if (typeof value === 'object' && 'n' in value) return Number(value.n).toLocaleString('ja-JP');
    if (key === 'calculation' && typeof value === 'object') return value.status === 'CALCULATED' ? `${value.totalMinutes}分／${yen(Math.round(value.pay240thYen / 240))}` : '管理者確認が必要';
    if (key === 'latestBackup' && typeof value === 'object') return value.file_name ?? '作成済み';
    return String(value);
  };
  return <div className="admin-panel table-wrap"><table><thead><tr>{keys.map(key => <th key={key}>{labels[key] ?? key}</th>)}{title === '従業員' && <th>操作</th>}</tr></thead><tbody>{rows.map((row: any, index: number) => <tr key={row.id ?? index}>{keys.map(key => <td key={key}>{display(key, row[key])}</td>)}{title === '従業員' && <td>{row.status === 'ARCHIVED' ? <div className="employee-actions"><button className="text-button" onClick={() => onArchive(row.id, true)}>復元</button><button className="text-button danger" onClick={() => onPermanentlyDelete(row.id, row.name)}>完全に削除</button></div> : <button className="text-button" onClick={() => onArchive(row.id)}>削除</button>}</td>}</tr>)}</tbody></table></div>;
}

createRoot(document.getElementById('root')!).render(<App />);

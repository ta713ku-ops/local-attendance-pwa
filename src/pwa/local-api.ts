import type { Command, Result } from '../shared/api';
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { allocateEmployeeMonthPay, calculateShift, formatJstDate, formatJstMonth, getAttendanceStatus } from '../domain';
import type {
  AttendanceDayDto, AttendanceShiftDto, BackupItemDto, BackupStatusDto, CorrectionDetailDto,
  CorrectionHistoryDto, CorrectionInput, EmployeeDto, MonthlyEmployeeDetailDto, MonthlyEmployeeDto,
  MonthlySummaryDto, PayBreakdownDto, PwaAttendanceApi,
} from './pwa-api.types';
import type {
  LocalBackup, LocalBackupPayload, LocalBackupPayloadV2, LocalCorrection, LocalEmployee, LocalException, LocalLog,
  LocalPeriod, LocalReceipt, LocalShift, SnapshotStoreName, StoreName,
} from './local-api.types';

const DB_NAME = 'local-attendance-pwa';
const DB_VERSION = 1;
const STORES: StoreName[] = ['meta', 'employees', 'shifts', 'corrections', 'exceptions', 'periods', 'logs', 'receipts', 'backups'];
const SNAPSHOT_STORES: SnapshotStoreName[] = ['meta', 'employees', 'shifts', 'corrections', 'exceptions', 'periods', 'logs'];
const encoder = new TextEncoder();
const ok = <T>(data: T): Result<T> => ({ ok: true, data });
const hasJapaneseText = (value: string) => /[ぁ-んァ-ヶ一-龠]/.test(value);
function publicErrorMessage(error: unknown) {
  if (error instanceof Error && error.name === 'QuotaExceededError') return '端末の保存容量が不足しています。不要なデータを整理してから、もう一度お試しください。';
  if (error instanceof Error && hasJapaneseText(error.message)) return error.message;
  return '処理を完了できませんでした。アプリを開き直して、もう一度お試しください。';
}
const fail = (error: unknown, needsAuth = false): Result<never> => ({ ok: false, code: 'OPERATION_FAILED', message: publicErrorMessage(error), needsAuth });
function secureRandomBytes(length: number) {
  if (!globalThis.crypto?.getRandomValues) throw new Error('安全な乱数を生成できないため操作できません');
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}
const uuid = () => {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const value = secureRandomBytes(16); value[6] = (value[6] & 0x0f) | 0x40; value[8] = (value[8] & 0x3f) | 0x80;
  const hex = [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const jstDayNumber = (at: number) => Math.floor((at + 9 * 60 * 60 * 1000) / 86_400_000);
const validateMonth = (value: string) => { if (!/^\d{4}-\d{2}$/.test(value)) throw new Error('対象月を確認してください'); };
const validateDate = (value: string) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('対象日を確認してください'); };
const validatePin = (pin: string) => { if (!/^\d{6}$/.test(pin)) throw new Error('PINは6桁の数字です'); };
const csvCell = (value: unknown) => { let text = value == null ? '' : String(value); if (/^[=+\-@]/.test(text)) text = `'${text}`; return `"${text.replace(/"/g, '""')}"`; };

function request<T = unknown>(input: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { input.onsuccess = () => resolve(input.result); input.onerror = () => reject(input.error ?? new Error('IndexedDB error')); });
}
function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed')); tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted')); });
}
export function openLocalAttendanceDatabase(name = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(name, DB_VERSION);
    opening.onupgradeneeded = () => { const db = opening.result; for (const store of STORES) if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: store === 'meta' ? 'key' : store === 'receipts' ? 'requestId' : store === 'periods' ? 'month' : 'id' }); };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error('ローカルデータを開けませんでした'));
  });
}
async function getAll<T>(db: IDBDatabase, store: StoreName): Promise<T[]> { return request(db.transaction(store, 'readonly').objectStore(store).getAll()) as Promise<T[]>; }
async function getOne<T>(db: IDBDatabase, store: StoreName, key: IDBValidKey): Promise<T | undefined> { return request(db.transaction(store, 'readonly').objectStore(store).get(key)) as Promise<T | undefined>; }
async function putOne(db: IDBDatabase, store: StoreName, value: unknown): Promise<void> { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value); await transactionDone(tx); }
async function meta<T>(db: IDBDatabase, key: string): Promise<T | undefined> { return (await getOne<{ key: string; value: T }>(db, 'meta', key))?.value; }
async function setMeta(db: IDBDatabase, key: string, value: unknown) { await putOne(db, 'meta', { key, value }); }
function bytesToBase64(value: Uint8Array) { let s = ''; for (const byte of value) s += String.fromCharCode(byte); return btoa(s); }
function base64ToBytes(value: string) { const s = atob(value); return Uint8Array.from(s, (c) => c.charCodeAt(0)); }
function randomSecret(bytes = 24) { return bytesToBase64(secureRandomBytes(bytes)).replace(/[+/=]/g, ''); }
async function hashSecret(secret: string, salt?: Uint8Array) {
  const actualSalt = salt ?? secureRandomBytes(16);
  const subtle = globalThis.crypto?.subtle;
  let digest: Uint8Array;
  if (subtle) {
    const key = await subtle.importKey('raw', encoder.encode(secret), 'PBKDF2', false, ['deriveBits']);
    digest = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', salt: actualSalt, iterations: 310_000, hash: 'SHA-256' }, key, 256));
  } else {
    digest = await pbkdf2Async(sha256, encoder.encode(secret), actualSalt, { c: 310_000, dkLen: 32, asyncTick: 8 });
  }
  return `pbkdf2-sha256:310000:${bytesToBase64(actualSalt)}:${bytesToBase64(digest)}`;
}
async function checkSecret(secret: string, stored: string) { const [algorithm, iterations, salt, digest] = stored.split(':'); if (algorithm !== 'pbkdf2-sha256' || iterations !== '310000' || !salt || !digest) return false; const actual = encoder.encode(await hashSecret(secret, base64ToBytes(salt))); const expected = encoder.encode(stored); if (actual.length !== expected.length) return false; let difference = 0; for (let i = 0; i < actual.length; i += 1) difference |= actual[i] ^ expected[i]; return difference === 0; }

type AdminRecord = { pinHash: string; recoveryHash: string; displayName: string; failedCount: number; lockedUntil: number };
type EffectiveRow = { shift: LocalShift; employee: LocalEmployee | undefined; correction: LocalCorrection | undefined; pending: LocalCorrection | undefined; clockIn: number; clockOut: number | null; wage: number; method: 'HALF_HOUR' | 'ACTUAL_MINUTES'; longConfirmed: boolean; state: 'OPEN' | 'CALCULATED' | 'NEEDS_REVIEW'; calculation: ReturnType<typeof calculateShift> | null; workDate: string; month: string };

function employeeDto(row: LocalEmployee): EmployeeDto { return { id: row.id, name: row.name, hourlyWage: row.hourly_wage, status: row.status ?? 'ACTIVE', archivedAt: row.archived_at ?? null, restoreUntil: row.restore_until ?? null }; }
function zeroPay(): PayBreakdownDto { return { totalMinutes: 0, regularMinutes: 0, nightMinutes: 0, regularYen: 0, nightYen: 0, totalYen: 0 }; }
function addPay(a: PayBreakdownDto, b: PayBreakdownDto): PayBreakdownDto { return { totalMinutes: a.totalMinutes + b.totalMinutes, regularMinutes: a.regularMinutes + b.regularMinutes, nightMinutes: a.nightMinutes + b.nightMinutes, regularYen: a.regularYen + b.regularYen, nightYen: a.nightYen + b.nightYen, totalYen: a.totalYen + b.totalYen }; }
function latestApproved(rows: LocalCorrection[]) { return rows.filter((x) => x.status === 'APPROVED').sort((a, b) => (b.applied_at ?? b.created_at) - (a.applied_at ?? a.created_at) || b.created_at - a.created_at || b.id.localeCompare(a.id))[0]; }

function allocate(rows: EffectiveRow[]): Map<string, PayBreakdownDto> {
  const output = new Map<string, PayBreakdownDto>();
  const groups = new Map<string, EffectiveRow[]>();
  for (const row of rows.filter((x) => x.calculation?.status === 'CALCULATED')) { const key = `${row.shift.employee_id}|${row.month}`; groups.set(key, [...(groups.get(key) ?? []), row]); }
  for (const group of groups.values()) {
    const allocation = allocateEmployeeMonthPay(group[0].shift.employee_id, group[0].month, group.map((row) => ({ shiftId: row.shift.id, employeeId: row.shift.employee_id, status: row.calculation!.status, effectiveClockIn: row.clockIn, regularPay240thYen: row.calculation!.regularPay240thYen, nightPay240thYen: row.calculation!.nightPay240thYen })));
    for (const row of group) { const assigned = allocation.shifts.find((x) => x.shiftId === row.shift.id)!; output.set(row.shift.id, { totalMinutes: row.calculation!.totalMinutes, regularMinutes: row.calculation!.regularMinutes, nightMinutes: row.calculation!.nightMinutes, regularYen: assigned.regular.allocatedYen, nightYen: assigned.night.allocatedYen, totalYen: assigned.allocatedYen }); }
  }
  return output;
}

function validateBackup(value: unknown): LocalBackupPayloadV2 {
  if (!value || typeof value !== 'object') throw new Error('バックアップJSONが壊れています');
  const payload = value as Partial<LocalBackupPayload>;
  if (payload.format !== 'local-attendance-pwa-backup' || (payload.version !== 1 && payload.version !== 2) || !payload.stores || typeof payload.exportedAt !== 'number') throw new Error('対応していないバックアップです');
  const stores = {} as Record<SnapshotStoreName, unknown[]>;
  for (const name of SNAPSHOT_STORES) {
    const rows = payload.stores[name];
    if (payload.version === 2 && !Array.isArray(rows)) throw new Error(`バックアップに ${name} がありません`);
    if (rows !== undefined && !Array.isArray(rows)) throw new Error(`${name} の形式が壊れています`);
    stores[name] = rows ?? [];
  }
  const employees = stores.employees;
  const shifts = stores.shifts;
  if (employees.some((x) => !x || typeof x !== 'object' || typeof (x as LocalEmployee).id !== 'string' || typeof (x as LocalEmployee).name !== 'string' || typeof (x as LocalEmployee).hourly_wage !== 'number')) throw new Error('従業員データが壊れています');
  if (shifts.some((x) => { const row = x as LocalShift; return !x || typeof x !== 'object' || typeof row.id !== 'string' || typeof row.employee_id !== 'string' || typeof row.clock_in !== 'number' || typeof row.wage_snapshot !== 'number' || (row.voided_at !== undefined && row.voided_at !== null && typeof row.voided_at !== 'number') || (row.void_reason !== undefined && row.void_reason !== null && typeof row.void_reason !== 'string'); })) throw new Error('勤務データが壊れています');
  if (stores.meta.some((x) => !x || typeof x !== 'object' || typeof (x as { key?: unknown }).key !== 'string' || !('value' in x))) throw new Error('管理情報が壊れています');
  if (stores.corrections.some((x) => { const row = x as Partial<LocalCorrection>; return !x || typeof x !== 'object' || typeof row.id !== 'string' || typeof row.shift_id !== 'string' || typeof row.start_at !== 'number' || typeof row.end_at !== 'number' || !['PENDING', 'APPROVED', 'REJECTED'].includes(row.status ?? '') || typeof row.created_at !== 'number'; })) throw new Error('訂正データが壊れています');
  if (stores.exceptions.some((x) => { const row = x as Partial<LocalException>; return !x || typeof x !== 'object' || typeof row.id !== 'string' || typeof row.shift_id !== 'string' || row.status !== 'APPROVED' || typeof row.approved_at !== 'number'; })) throw new Error('例外データが壊れています');
  if (stores.periods.some((x) => { const row = x as Partial<LocalPeriod>; return !x || typeof x !== 'object' || typeof row.month !== 'string' || !/^\d{4}-\d{2}$/.test(row.month) || !['OPEN', 'CLOSED'].includes(row.status ?? ''); })) throw new Error('月確定データが壊れています');
  if (stores.logs.some((x) => { const row = x as Partial<LocalLog>; return !x || typeof x !== 'object' || typeof row.id !== 'string' || typeof row.created_at !== 'number' || typeof row.kind !== 'string' || typeof row.result !== 'string'; })) throw new Error('操作履歴が壊れています');
  for (const name of SNAPSHOT_STORES) {
    const keys = stores[name].map((item) => storeKey(name, item));
    if (keys.some((key) => key === undefined)) throw new Error(`${name} の必須キーがありません`);
    if (new Set(keys.map(String)).size !== keys.length) throw new Error(`${name} に重複キーがあります`);
  }
  const employeeIds = new Set(employees.map((x) => (x as LocalEmployee).id));
  if (shifts.some((x) => !employeeIds.has((x as LocalShift).employee_id))) throw new Error('勤務が存在しない従業員を参照しています');
  const shiftIds = new Set(shifts.map((x) => (x as LocalShift).id));
  if ([...stores.corrections, ...stores.exceptions].some((x) => !shiftIds.has((x as LocalCorrection | LocalException).shift_id))) throw new Error('訂正または例外が存在しない勤務を参照しています');
  return { format: 'local-attendance-pwa-backup', version: 2, exportedAt: payload.exportedAt, stores };
}

function storeKey(name: SnapshotStoreName, value: unknown): IDBValidKey | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  const key = name === 'meta' ? row.key : name === 'periods' ? row.month : row.id;
  return typeof key === 'string' || typeof key === 'number' ? key : undefined;
}

export interface LocalAttendanceController {
  api: PwaAttendanceApi;
  exportBackupJson(): Promise<string>;
  importBackupJson(json: string): Promise<Result<{ imported: true; requiresReauthentication: true }>>;
  ensureAutoBackup(): Promise<void>;
  close(): void;
}

export async function createLocalAttendanceApi(options: { dbName?: string; now?: () => number } = {}): Promise<LocalAttendanceController> {
  const db = await openLocalAttendanceDatabase(options.dbName);
  const now = options.now ?? Date.now;
  let adminUntil = 0;
  let writeQueue: Promise<void> = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => { const next = writeQueue.then(operation, operation); writeQueue = next.then(() => undefined, () => undefined); return next; };
  const requireAdmin = () => { if (now() > adminUntil) throw new Error('再認証が必要です'); };
  const verifyAdminSecret = async (pin: string) => { validatePin(pin); const admin = await meta<AdminRecord>(db, 'administrator'); if (!admin) throw new Error('管理者PINが未設定です'); if (admin.lockedUntil > now()) throw new Error('一時的にロックされています'); if (!(await checkSecret(pin, admin.pinHash))) { const failedCount = admin.failedCount + 1; await setMeta(db, 'administrator', { ...admin, failedCount: failedCount >= 5 ? 0 : failedCount, lockedUntil: failedCount >= 5 ? now() + 300_000 : 0 }); throw new Error('管理者PINが正しくありません'); } await setMeta(db, 'administrator', { ...admin, failedCount: 0, lockedUntil: 0 }); return admin; };
  const withRead = async <T>(operation: () => Promise<T>, admin = true): Promise<Result<T>> => { try { if (admin) requireAdmin(); return ok(await operation()); } catch (error) { return fail(error, admin); } };
  const log = async (kind: string, target?: string, requestId?: string) => putOne(db, 'logs', { id: uuid(), created_at: now(), kind, target_id: target ?? null, request_id: requestId ?? null, result: 'SUCCESS' } satisfies LocalLog);
  const command = <T>(kind: string, input: { requestId: string }, operation: () => Promise<T>, admin = true, persistReceipt = true): Promise<Result<T>> => serialized(async () => { try { if (admin) requireAdmin(); if (!input?.requestId) throw new Error('requestIdが必要です'); const previous = persistReceipt ? await getOne<LocalReceipt>(db, 'receipts', input.requestId) : undefined; if (previous) return previous.kind === kind ? previous.result as Result<T> : { ok: false, code: 'REQUEST_ID_REUSED', message: 'requestId は別の操作に再利用できません。' }; const result = ok(await operation()); if (persistReceipt) await putOne(db, 'receipts', { requestId: input.requestId, kind, result, createdAt: now() } satisfies LocalReceipt); return result; } catch (error) { return fail(error, admin); } });
  const periodClosed = async (month: string) => (await getOne<LocalPeriod>(db, 'periods', month))?.status === 'CLOSED';
  const rows = async (): Promise<EffectiveRow[]> => {
    const [shifts, employees, corrections, exceptions] = await Promise.all([getAll<LocalShift>(db, 'shifts'), getAll<LocalEmployee>(db, 'employees'), getAll<LocalCorrection>(db, 'corrections'), getAll<LocalException>(db, 'exceptions')]);
    const employeeMap = new Map(employees.map((x) => [x.id, x]));
    return shifts.filter((shift) => shift.voided_at == null).map((shift) => {
      const related = corrections.filter((x) => x.shift_id === shift.id); const correction = latestApproved(related); const pending = related.find((x) => x.status === 'PENDING');
      const clockIn = correction?.start_at ?? shift.clock_in; const clockOut = correction?.end_at ?? shift.clock_out ?? null; const wage = correction?.hourly_wage ?? shift.wage_snapshot; const method = correction?.calculation_method ?? (exceptions.some((x) => x.shift_id === shift.id) ? 'ACTUAL_MINUTES' : 'HALF_HOUR'); const longConfirmed = correction?.long_shift_confirmed ?? exceptions.some((x) => x.shift_id === shift.id);
      const calculation = clockOut == null ? null : calculateShift({ clockIn, clockOut, hourlyWageYen: wage, approvedActualMinutes: method === 'ACTUAL_MINUTES', approvedLongShiftReview: longConfirmed });
      return { shift, employee: employeeMap.get(shift.employee_id), correction, pending, clockIn, clockOut, wage, method, longConfirmed, state: clockOut == null ? 'OPEN' : calculation!.status, calculation, workDate: formatJstDate(clockIn), month: formatJstMonth(clockIn) };
    });
  };
  const dtoRows = async () => { const all = await rows(); const allocated = allocate(all); const occurrence = new Map<string, number>(); return all.sort((a, b) => a.clockIn - b.clockIn || a.shift.id.localeCompare(b.shift.id)).map((row): AttendanceShiftDto => { const key = `${row.shift.employee_id}|${row.workDate}`; const count = (occurrence.get(key) ?? 0) + 1; occurrence.set(key, count); return { id: row.shift.id, employeeId: row.shift.employee_id, employeeName: row.employee?.name ?? '削除済み', workDate: row.workDate, effectiveClockIn: row.clockIn, effectiveClockOut: row.clockOut, state: row.state, occurrenceOfDay: count, pay: allocated.get(row.shift.id) ?? null }; }); };
  const correctionDetail = async (shiftId: string): Promise<CorrectionDetailDto> => { const all = await rows(); const row = all.find((x) => x.shift.id === shiftId); if (!row) throw new Error('勤務が見つかりません'); const dto = (await dtoRows()).find((x) => x.id === shiftId)!; const history = (await getAll<LocalCorrection>(db, 'corrections')).filter((x) => x.shift_id === shiftId).sort((a, b) => b.created_at - a.created_at).map((x): CorrectionHistoryDto => ({ id: x.id, startAt: x.start_at, endAt: x.end_at, hourlyWage: x.hourly_wage ?? row.shift.wage_snapshot, reason: x.reason ?? '', calculationMethod: x.calculation_method ?? 'HALF_HOUR', longShiftConfirmed: x.long_shift_confirmed ?? false, status: x.status, appliedAt: x.applied_at ?? x.decided_at ?? null, createdAt: x.created_at })); return { shiftId, employeeId: row.shift.employee_id, employeeName: row.employee?.name ?? '削除済み', originalClockIn: row.shift.clock_in, originalClockOut: row.shift.clock_out ?? null, originalHourlyWage: row.shift.wage_snapshot, effectiveClockIn: row.clockIn, effectiveClockOut: row.clockOut, effectiveHourlyWage: row.wage, calculationMethod: row.method, longShiftConfirmed: row.longConfirmed, currentPay: dto.pay, history }; };
  const summary = async (month: string): Promise<MonthlySummaryDto> => { validateMonth(month); const all = await rows(); const selected = all.filter((x) => x.month === month); const dtos = await dtoRows(); const employeeIds = [...new Set(selected.map((x) => x.shift.employee_id))]; const employees: MonthlyEmployeeDto[] = employeeIds.map((employeeId) => { const subset = selected.filter((x) => x.shift.employee_id === employeeId); const pay = subset.map((x) => dtos.find((d) => d.id === x.shift.id)?.pay).filter((x): x is PayBreakdownDto => Boolean(x)).reduce(addPay, zeroPay()); return { employeeId, employeeName: subset[0].employee?.name ?? '削除済み', attendanceCount: subset.length, ...pay }; }).sort((a, b) => b.totalYen - a.totalYen || a.employeeName.localeCompare(b.employeeName, 'ja')); const totals = employees.reduce<PayBreakdownDto>((acc, x) => addPay(acc, x), zeroPay()); const openCount = selected.filter((x) => x.state === 'OPEN').length; const reviewCount = selected.filter((x) => x.state === 'NEEDS_REVIEW').length; const legacyPendingCount = selected.filter((x) => x.pending).length; const status = (await periodClosed(month)) ? 'CLOSED' : 'OPEN'; return { month, status, employees, attendanceCount: selected.length, openCount, reviewCount, legacyPendingCount, canClose: selected.length > 0 && status === 'OPEN' && openCount + reviewCount + legacyPendingCount === 0, ...totals }; };

  const exportPayload = async (): Promise<LocalBackupPayload> => { const stores = {} as Record<SnapshotStoreName, unknown[]>; for (const store of SNAPSHOT_STORES) stores[store] = await getAll(db, store); return { format: 'local-attendance-pwa-backup', version: 2, exportedAt: now(), stores }; };
  const pruneBackups = async () => { const cutoff = jstDayNumber(now()) - 90; const old = (await getAll<LocalBackup>(db, 'backups')).filter((x) => jstDayNumber(x.created_at) < cutoff); if (!old.length) return; const tx = db.transaction('backups', 'readwrite'); for (const item of old) tx.objectStore('backups').delete(item.id); await transactionDone(tx); };
  const createBackup = async (kind: LocalBackup['kind']): Promise<LocalBackup> => { try { await pruneBackups(); const snapshot = await exportPayload(); const json = JSON.stringify(snapshot); const item: LocalBackup = { id: uuid(), file_name: `local-attendance-${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${kind}.json`, kind, status: 'SUCCESS', size: encoder.encode(json).byteLength, created_at: now(), error: null, snapshot }; await putOne(db, 'backups', item); await setMeta(db, 'backupLastSuccessAt', item.created_at); await pruneBackups(); return item; } catch (error) { try { await setMeta(db, 'backupLastFailure', { at: now(), message: error instanceof Error ? error.message : 'バックアップに失敗しました' }); } catch { /* A quota failure can also prevent recording its status. */ } throw error; } };
  const ensureAutoBackup = () => serialized(async () => { const today = jstDayNumber(now()); if ((await getAll<LocalBackup>(db, 'backups')).some((x) => x.kind === 'AUTO' && x.status === 'SUCCESS' && jstDayNumber(x.created_at) === today)) { await pruneBackups(); return; } try { await createBackup('AUTO'); } catch (error) { await setMeta(db, 'backupLastFailure', { at: now(), message: error instanceof Error ? error.message : '自動バックアップに失敗しました' }); } });
  const restorePayload = async (payload: LocalBackupPayload) => { const administrator = await meta<AdminRecord>(db, 'administrator'); await createBackup('PRE_RESTORE'); const tx = db.transaction(SNAPSHOT_STORES, 'readwrite'); try { const expected = new Map<SnapshotStoreName, number>(); for (const name of SNAPSHOT_STORES) { const items = (payload.stores[name] ?? []).filter((item) => !(name === 'meta' && (item as { key?: string }).key === 'administrator')); expected.set(name, items.length + (name === 'meta' && administrator ? 1 : 0)); const store = tx.objectStore(name); store.clear(); for (const item of items) store.put(item); } if (administrator) tx.objectStore('meta').put({ key: 'administrator', value: administrator }); for (const name of SNAPSHOT_STORES) { const count = await request(tx.objectStore(name).count()); if (count !== expected.get(name)) throw new Error(`${name} の復元件数が一致しません`); } if (administrator) { const restoredAdmin = await request<{ key: string; value: AdminRecord } | undefined>(tx.objectStore('meta').get('administrator')); if (!restoredAdmin || restoredAdmin.value.pinHash !== administrator.pinHash || restoredAdmin.value.recoveryHash !== administrator.recoveryHash) throw new Error('現在の管理者情報を維持できませんでした'); } await transactionDone(tx); adminUntil = 0; } catch (error) { try { tx.abort(); } catch { /* Already aborted. */ } throw error; } };
  const importBackupJson = async (json: string): Promise<Result<{ imported: true; requiresReauthentication: true }>> => serialized(async () => { try { requireAdmin(); const payload = validateBackup(JSON.parse(json)); await restorePayload(payload); return ok({ imported: true, requiresReauthentication: true }); } catch (error) { return fail(error, true); } });

  const api: PwaAttendanceApi = {
    clock: {
      home: () => withRead(async () => { const [administrator, employees, shifts] = await Promise.all([meta<AdminRecord>(db, 'administrator'), getAll<LocalEmployee>(db, 'employees'), getAll<LocalShift>(db, 'shifts')]); const visibleShifts = shifts.filter((x) => x.voided_at == null); const today = formatJstDate(now()); return { adminConfigured: Boolean(administrator), employees: employees.filter((x) => (x.status ?? 'ACTIVE') === 'ACTIVE').sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0)).map((employee) => { const own = visibleShifts.filter((x) => x.employee_id === employee.id); const open = own.find((x) => x.clock_out == null); return { ...employeeDto(employee), status: open ? 'WORKING' as const : own.some((x) => x.clock_out != null && formatJstDate(x.clock_in) === today) ? 'CLOCKED_OUT_TODAY' as const : 'ACTIVE' as const, ...(open ? { startedAt: open.clock_in } : {}) }; }) }; }, false),
      status: (employeeId) => withRead(async () => { const employee = await getOne<LocalEmployee>(db, 'employees', employeeId); if (!employee) throw new Error('従業員が見つかりません'); const shifts = (await getAll<LocalShift>(db, 'shifts')).filter((x) => x.employee_id === employeeId && x.voided_at == null); const latest = [...shifts].sort((a, b) => (b.created_at ?? b.clock_in) - (a.created_at ?? a.clock_in))[0]; const status = getAttendanceStatus({ shifts: shifts.map((x) => ({ clockIn: x.clock_in, clockOut: x.clock_out })), now: now(), employeeArchived: employee.status === 'ARCHIVED', monthClosed: await periodClosed(formatJstMonth(now())) }); if (status === 'ARCHIVED') throw new Error('削除済みの従業員です'); return { id: latest?.id, employeeId, businessDate: latest ? formatJstDate(latest.clock_in) : null, clockIn: latest?.clock_in ?? null, clockOut: latest?.clock_out ?? null, status }; }, false),
      clockIn: (input) => command('clock:in', input, async () => { const employee = await getOne<LocalEmployee>(db, 'employees', input.employeeId); if (!employee || employee.status === 'ARCHIVED') throw new Error('従業員が見つかりません'); if (await periodClosed(formatJstMonth(now()))) throw new Error('月締め済みです'); const shifts = (await getAll<LocalShift>(db, 'shifts')).filter((x) => x.voided_at == null); if (shifts.some((x) => x.employee_id === employee.id && x.clock_out == null)) throw new Error('すでに出勤中です'); if (shifts.some((x) => x.employee_id === employee.id && x.clock_out != null && formatJstDate(x.clock_in) === formatJstDate(now())) && !input.reClockAcknowledged) throw new Error('本日は退勤済みです。再出勤を確認してください'); const at = now(); const shift: LocalShift = { id: uuid(), employee_id: employee.id, business_date: formatJstDate(at), clock_in: at, clock_out: null, wage_snapshot: employee.hourly_wage, calc_status: 'OPEN', created_at: at }; await putOne(db, 'shifts', shift); await log('CLOCK_IN', employee.id, input.requestId); return { shiftId: shift.id, employeeId: employee.id, businessDate: formatJstDate(at), clockIn: at, clockOut: null, state: 'OPEN' as const }; }, false),
      clockOut: (input) => command('clock:out', input, async () => { const shift = (await getAll<LocalShift>(db, 'shifts')).find((x) => x.employee_id === input.employeeId && x.clock_out == null && x.voided_at == null); if (!shift) throw new Error('出勤中の勤務がありません'); if (await periodClosed(formatJstMonth(shift.clock_in))) throw new Error('月締め済みです'); if (now() <= shift.clock_in) throw new Error('端末時刻を確認してください'); const clockOut = now(); const calculation = calculateShift({ clockIn: shift.clock_in, clockOut, hourlyWageYen: shift.wage_snapshot }); const updated = { ...shift, clock_out: clockOut, calc_status: calculation.status }; await putOne(db, 'shifts', updated); await log('CLOCK_OUT', input.employeeId, input.requestId); return { shiftId: shift.id, employeeId: shift.employee_id, businessDate: formatJstDate(shift.clock_in), clockIn: shift.clock_in, clockOut, state: calculation.status }; }, false),
    },
    adminAuth: {
      setup: (input) => command('auth:setup', input, async () => { validatePin(input.pin); if (await meta(db, 'administrator')) throw new Error('管理者は設定済みです'); const recoveryCode = randomSecret(); await setMeta(db, 'administrator', { pinHash: await hashSecret(input.pin), recoveryHash: await hashSecret(recoveryCode), displayName: input.displayName?.trim() || '管理者', failedCount: 0, lockedUntil: 0 } satisfies AdminRecord); adminUntil = now() + 300_000; return { recoveryCode }; }, false, false),
      verify: async (input) => { try { await verifyAdminSecret(input.pin); adminUntil = now() + 300_000; return ok({ authenticatedUntil: adminUntil }); } catch (error) { return fail(error); } },
      lock: async () => { adminUntil = 0; },
      changePin: (input) => command('auth:change', input, async () => { validatePin(input.newPin); const admin = await meta<AdminRecord>(db, 'administrator'); if (!admin || !(await checkSecret(input.oldPin, admin.pinHash))) throw new Error('現在のPINが正しくありません'); await setMeta(db, 'administrator', { ...admin, pinHash: await hashSecret(input.newPin), failedCount: 0, lockedUntil: 0 }); adminUntil = now() + 300_000; return { changed: true }; }),
      resetWithRecovery: (input) => command('auth:recover', input, async () => { validatePin(input.newPin); const admin = await meta<AdminRecord>(db, 'administrator'); if (!admin || !(await checkSecret(input.recoveryCode, admin.recoveryHash))) throw new Error('回復コードが正しくありません'); const recoveryCode = randomSecret(); await setMeta(db, 'administrator', { ...admin, pinHash: await hashSecret(input.newPin), recoveryHash: await hashSecret(recoveryCode), failedCount: 0, lockedUntil: 0 }); adminUntil = now() + 300_000; return { recoveryCode }; }, false, false),
    },
    employees: {
      list: (includeArchived) => withRead(async () => (await getAll<LocalEmployee>(db, 'employees')).filter((x) => includeArchived || (x.status ?? 'ACTIVE') === 'ACTIVE').map(employeeDto).sort((a, b) => a.name.localeCompare(b.name, 'ja'))),
      create: (input) => command('employees:create', input, async () => { const name = input.name.trim(); if (!name || name.length > 80) throw new Error('氏名を入力してください'); if (!Number.isInteger(input.hourlyWage) || input.hourlyWage <= 0) throw new Error('時給を確認してください'); const all = await getAll<LocalEmployee>(db, 'employees'); const row: LocalEmployee = { id: uuid(), name, hourly_wage: input.hourlyWage, display_order: Math.max(0, ...all.map((x) => x.display_order ?? 0)) + 1, status: 'ACTIVE', version: 1 }; await putOne(db, 'employees', row); await log('EMPLOYEE_CREATE', row.id, input.requestId); return employeeDto(row); }),
      update: (input) => command('employees:update', input, async () => { const row = await getOne<LocalEmployee>(db, 'employees', input.id); if (!row) throw new Error('従業員が見つかりません'); if (input.name !== undefined && !input.name.trim()) throw new Error('氏名を入力してください'); if (input.hourlyWage !== undefined && (!Number.isInteger(input.hourlyWage) || input.hourlyWage <= 0)) throw new Error('時給を確認してください'); await putOne(db, 'employees', { ...row, ...(input.name !== undefined ? { name: input.name.trim() } : {}), ...(input.hourlyWage !== undefined ? { hourly_wage: input.hourlyWage } : {}), version: (row.version ?? 1) + 1 }); await log('EMPLOYEE_UPDATE', input.id, input.requestId); return { id: input.id }; }),
      archive: (input) => command('employees:archive', input, async () => { const row = await getOne<LocalEmployee>(db, 'employees', input.id); if (!row) throw new Error('従業員が見つかりません'); if ((await getAll<LocalShift>(db, 'shifts')).some((x) => x.employee_id === input.id && x.clock_out == null && x.voided_at == null)) throw new Error('出勤中の従業員は削除できません'); const at = now(); await putOne(db, 'employees', { ...row, status: 'ARCHIVED', archived_at: at, restore_until: at + 30 * 86_400_000 }); await log('EMPLOYEE_ARCHIVE', input.id, input.requestId); return { id: input.id, status: 'ARCHIVED' as const }; }),
      restore: (input) => command('employees:restore', input, async () => { const row = await getOne<LocalEmployee>(db, 'employees', input.id); if (!row || row.status !== 'ARCHIVED') throw new Error('削除済み従業員が見つかりません'); if ((row.restore_until ?? 0) < now()) throw new Error('復元可能な30日間を過ぎています'); await putOne(db, 'employees', { ...row, status: 'ACTIVE', archived_at: null, restore_until: null }); await log('EMPLOYEE_RESTORE', input.id, input.requestId); return { id: input.id, status: 'ACTIVE' as const }; }),
      permanentlyDelete: (input) => command('employees:permanently-delete', input, async () => { throw new Error('完全削除の方針は未確定です。データは変更されません。'); }),
    },
    attendance: {
      calendar: (month) => withRead(async () => { validateMonth(month); return { month, today: formatJstDate(now()), attendanceDates: [...new Set((await rows()).filter((x) => x.month === month).map((x) => x.workDate))].sort() }; }),
      day: (date) => withRead(async () => { validateDate(date); const all = await rows(); const selected = (await dtoRows()).filter((x) => x.workDate === date); const pay = selected.map((x) => x.pay).filter((x): x is PayBreakdownDto => Boolean(x)).reduce(addPay, zeroPay()); return { date, shifts: selected, totals: { ...pay, attendanceCount: selected.length, openCount: all.filter((x) => x.workDate === date && x.state === 'OPEN').length, reviewCount: all.filter((x) => x.workDate === date && x.state === 'NEEDS_REVIEW').length } }; }),
      correctionEmployees: () => withRead(async () => (await getAll<LocalEmployee>(db, 'employees')).map(employeeDto).sort((a, b) => a.name.localeCompare(b.name, 'ja'))),
      correctionShifts: (employeeId) => withRead(async () => { const all = (await rows()).filter((x) => x.shift.employee_id === employeeId); return all.sort((a, b) => b.clockIn - a.clockIn).map((x) => ({ shiftId: x.shift.id, employeeId, employeeName: x.employee?.name ?? '削除済み', workDate: x.workDate, effectiveClockIn: x.clockIn, effectiveClockOut: x.clockOut, state: x.state, corrected: Boolean(x.correction), legacyPending: Boolean(x.pending) })); }),
      correctionDetail: (shiftId) => withRead(() => correctionDetail(shiftId)),
      previewCorrection: (input) => withRead(async () => { const before = await correctionDetail(input.shiftId); if (input.endAt <= input.startAt) throw new Error('退勤は出勤より後にしてください'); if (!Number.isInteger(input.hourlyWage) || input.hourlyWage <= 0) throw new Error('時給を確認してください'); const calculation = calculateShift({ clockIn: input.startAt, clockOut: input.endAt, hourlyWageYen: input.hourlyWage, approvedActualMinutes: input.calculationMethod === 'ACTUAL_MINUTES', approvedLongShiftReview: input.longShiftConfirmed }); const current = await rows(); const original = current.find((x) => x.shift.id === input.shiftId); if (!original) throw new Error('勤務が見つかりません'); const temp: EffectiveRow = { ...original, clockIn: input.startAt, clockOut: input.endAt, wage: input.hourlyWage, method: input.calculationMethod, longConfirmed: input.longShiftConfirmed, state: calculation.status, calculation, workDate: formatJstDate(input.startAt), month: formatJstMonth(input.startAt) }; const postSaveRows = current.map((row) => row.shift.id === input.shiftId ? temp : row); return { before, after: { workDate: temp.workDate, month: temp.month, pay: allocate(postSaveRows).get(input.shiftId) ?? null, state: temp.state } }; }),
      applyCorrection: (input) => command('attendance:apply-correction', input, async () => { const shift = await getOne<LocalShift>(db, 'shifts', input.shiftId); if (!shift || shift.voided_at != null) throw new Error('勤務が見つかりません'); if (input.endAt <= input.startAt) throw new Error('退勤は出勤より後にしてください'); if (!Number.isInteger(input.hourlyWage) || input.hourlyWage <= 0) throw new Error('時給を確認してください'); const oldMonth = formatJstMonth(latestApproved((await getAll<LocalCorrection>(db, 'corrections')).filter((x) => x.shift_id === shift.id))?.start_at ?? shift.clock_in); const newMonth = formatJstMonth(input.startAt); if (await periodClosed(oldMonth) || await periodClosed(newMonth)) throw new Error('移動元または移動先の月が確定済みのため訂正できません'); const row: LocalCorrection = { id: uuid(), shift_id: shift.id, start_at: input.startAt, end_at: input.endAt, hourly_wage: input.hourlyWage, reason: input.reason?.trim() ?? '', calculation_method: input.calculationMethod, long_shift_confirmed: input.longShiftConfirmed, status: 'APPROVED', applied_at: now(), created_at: now() }; await putOne(db, 'corrections', row); await log('CORRECTION_APPLY', shift.id, input.requestId); return correctionDetail(shift.id); }),
      resolveLegacyCorrection: (input) => command('attendance:resolve-legacy', input, async () => { const row = await getOne<LocalCorrection>(db, 'corrections', input.correctionId); if (!row || row.status !== 'PENDING') throw new Error('旧承認待ち訂正が見つかりません'); const shift = await getOne<LocalShift>(db, 'shifts', row.shift_id); if (!shift || shift.voided_at != null) throw new Error('勤務が見つかりません'); const oldMonth = formatJstMonth(latestApproved((await getAll<LocalCorrection>(db, 'corrections')).filter((x) => x.shift_id === shift.id))?.start_at ?? shift.clock_in); const newMonth = formatJstMonth(row.start_at); if (input.action === 'APPLY' && (await periodClosed(oldMonth) || await periodClosed(newMonth))) throw new Error('移動元または移動先の月が確定済みのため反映できません'); await putOne(db, 'corrections', { ...row, status: input.action === 'APPLY' ? 'APPROVED' : 'REJECTED', applied_at: input.action === 'APPLY' ? now() : null, decided_at: now() }); await log(input.action === 'APPLY' ? 'LEGACY_CORRECTION_APPLY' : 'LEGACY_CORRECTION_REJECT', row.id, input.requestId); return correctionDetail(row.shift_id); }),
      voidShift: (input) => command('attendance:void', input, async () => { await verifyAdminSecret(input.adminPin); const shift = await getOne<LocalShift>(db, 'shifts', input.shiftId); if (!shift) throw new Error('勤務が見つかりません'); if (shift.voided_at != null) throw new Error('この勤務はすでに削除されています'); const correction = latestApproved((await getAll<LocalCorrection>(db, 'corrections')).filter((x) => x.shift_id === shift.id)); if (await periodClosed(formatJstMonth(correction?.start_at ?? shift.clock_in))) throw new Error('確定済みの月に属する勤務は削除できません'); const voidedAt = now(); const tx = db.transaction(['shifts', 'logs'], 'readwrite'); tx.objectStore('shifts').put({ ...shift, voided_at: voidedAt }); tx.objectStore('logs').put({ id: uuid(), created_at: voidedAt, kind: 'ATTENDANCE_VOID', target_id: shift.id, request_id: input.requestId, result: 'SUCCESS' } satisfies LocalLog); await transactionDone(tx); return { shiftId: shift.id, voidedAt }; }),
    },
    monthly: {
      summary: (month) => withRead(() => summary(month)),
      employeeDetail: (month, employeeId) => withRead(async (): Promise<MonthlyEmployeeDetailDto> => { const totals = (await summary(month)).employees.find((x) => x.employeeId === employeeId); const employee = await getOne<LocalEmployee>(db, 'employees', employeeId); if (!employee || !totals) throw new Error('従業員の月次データが見つかりません'); const shifts = (await dtoRows()).filter((x) => x.employeeId === employeeId && x.workDate.startsWith(month)); const days = [...new Set(shifts.map((x) => x.workDate))].sort().map((date) => { const own = shifts.filter((x) => x.workDate === date); return { date, shifts: own, totals: own.map((x) => x.pay).filter((x): x is PayBreakdownDto => Boolean(x)).reduce(addPay, zeroPay()) }; }); return { month, employee: employeeDto(employee), totals, days }; }),
      close: (input) => command('monthly:close', input, async () => { const current = await summary(input.month); if (!current.canClose) throw new Error('勤務中・要確認・旧承認待ち、または0件のため確定できません'); await putOne(db, 'periods', { month: input.month, status: 'CLOSED', closed_at: now() } satisfies LocalPeriod); await log('MONTH_CLOSE', input.month, input.requestId); return summary(input.month); }),
      reopen: (input) => command('monthly:reopen', input, async () => { if (!(await periodClosed(input.month))) throw new Error('月は確定されていません'); await putOne(db, 'periods', { month: input.month, status: 'OPEN', closed_at: null, reopened_at: now() } satisfies LocalPeriod); await log('MONTH_REOPEN', input.month, input.requestId); return summary(input.month); }),
      exportCsv: (month) => withRead(async () => { const monthSummary = await summary(month); const dtos = await dtoRows(); const all = await rows(); const header = ['行種別', '氏名', '勤務日', '実効出勤', '実効退勤', '通常時間', '深夜時間', '通常金額', '深夜金額', '合計金額', '状態']; const lines: string[] = [header.map(csvCell).join(',')]; for (const row of all.filter((x) => x.month === month).sort((a, b) => a.clockIn - b.clockIn || a.shift.id.localeCompare(b.shift.id))) { const dto = dtos.find((x) => x.id === row.shift.id)!; lines.push(['明細', dto.employeeName, dto.workDate, new Date(dto.effectiveClockIn).toISOString(), dto.effectiveClockOut == null ? '' : new Date(dto.effectiveClockOut).toISOString(), dto.pay?.regularMinutes ?? '', dto.pay?.nightMinutes ?? '', dto.pay?.regularYen ?? '', dto.pay?.nightYen ?? '', dto.pay?.totalYen ?? '', dto.state].map(csvCell).join(',')); } for (const employee of monthSummary.employees) lines.push(['従業員合計', employee.employeeName, '', '', '', employee.regularMinutes, employee.nightMinutes, employee.regularYen, employee.nightYen, employee.totalYen, ''].map(csvCell).join(',')); lines.push(['月全体合計', '', month, '', '', monthSummary.regularMinutes, monthSummary.nightMinutes, monthSummary.regularYen, monthSummary.nightYen, monthSummary.totalYen, monthSummary.status].map(csvCell).join(',')); lines.push([csvCell('※残業・休日割増は含まれていません')].join(',')); return { fileName: `給与見込み-${month}.csv`, mimeType: 'text/csv;charset=utf-8', csv: `\uFEFF${lines.join('\r\n')}` }; }),
      print: (month) => withRead(() => summary(month)),
    },
    backup: {
      status: () => withRead(async (): Promise<BackupStatusDto> => { let persisted: boolean | null = null; let usage: number | null = null; let quota: number | null = null; try { persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null; if (navigator.storage?.estimate) { const estimate = await navigator.storage.estimate(); usage = estimate.usage ?? null; quota = estimate.quota ?? null; } } catch { /* Browser storage status is advisory. */ } const lastSuccessAt = await meta<number>(db, 'backupLastSuccessAt') ?? null; const failure = await meta<{ at: number; message: string }>(db, 'backupLastFailure'); return { persisted, usage, quota, lastSuccessAt, lastFailureAt: failure?.at ?? null, lastFailure: failure?.message ?? null }; }),
      list: () => withRead(async () => (await getAll<LocalBackup>(db, 'backups')).sort((a, b) => b.created_at - a.created_at).map((x): BackupItemDto => ({ id: x.id, fileName: x.file_name, kind: x.kind, status: x.status, size: x.size, createdAt: x.created_at, error: x.error ?? null }))),
      create: (input) => command('backup:create', input, async () => { const item = await createBackup(input.kind ?? 'MANUAL'); return { id: item.id, fileName: item.file_name, kind: item.kind, status: item.status, size: item.size, createdAt: item.created_at, error: item.error ?? null }; }),
      export: (id) => withRead(async () => { const item = await getOne<LocalBackup>(db, 'backups', id); if (!item?.snapshot) throw new Error('バックアップが見つかりません'); return { fileName: item.file_name, json: JSON.stringify(item.snapshot) }; }),
      restore: (input) => command('backup:restore', input, async () => { const item = await getOne<LocalBackup>(db, 'backups', input.id); if (!item?.snapshot) throw new Error('バックアップが見つかりません'); await restorePayload(validateBackup(item.snapshot)); return { restored: true as const, requiresReauthentication: true as const }; }),
    },
  };
  return { api, exportBackupJson: async () => { requireAdmin(); return JSON.stringify(await exportPayload()); }, importBackupJson, ensureAutoBackup, close: () => db.close() };
}

let installedController: LocalAttendanceController | undefined;
export async function installLocalAttendanceApi(target: Window = window, options: { dbName?: string; now?: () => number } = {}): Promise<LocalAttendanceController> { const controller = await createLocalAttendanceApi(options); try { Object.defineProperty(target, 'attendance', { value: Object.freeze(controller.api), configurable: true, writable: false }); } catch (error) { controller.close(); throw error; } installedController?.close(); installedController = controller; return controller; }
export async function restoreBackupFile(file: File): Promise<Result<{ imported: true; requiresReauthentication: true }>> { if (!installedController) return { ok: false, code: 'NOT_INITIALIZED', message: 'ローカル勤怠データが開始されていません。' }; if (!file || typeof file.text !== 'function') return { ok: false, code: 'INVALID_BACKUP_FILE', message: 'バックアップファイルを選択してください。' }; try { return await installedController.importBackupJson(await file.text()); } catch (error) { return fail(error, true); } }
export async function exportBackup(): Promise<{ fileName: string; json: string }> { if (!installedController) throw new Error('ローカル勤怠データが開始されていません。'); return { fileName: `local-attendance-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, json: await installedController.exportBackupJson() }; }
export const installWebAttendanceApi = installLocalAttendanceApi;

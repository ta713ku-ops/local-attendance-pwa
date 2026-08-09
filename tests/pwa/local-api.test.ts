import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalAttendanceApi, openLocalAttendanceDatabase, type LocalAttendanceController } from '../../src/pwa/local-api';
import type { LocalBackup, LocalCorrection, LocalEmployee, LocalPeriod, LocalShift, StoreName } from '../../src/pwa/local-api.types';

const controllers: LocalAttendanceController[] = [];
const names: string[] = [];
const at = (iso: string) => Date.parse(iso);
const command = <T extends object>(value: T) => ({ ...value, requestId: crypto.randomUUID() });

async function withoutCryptoSubtle<T>(operation: () => Promise<T>, omitRandomUuid = false): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const original = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
    getRandomValues: original.getRandomValues.bind(original),
    randomUUID: omitRandomUuid ? undefined : original.randomUUID.bind(original),
    subtle: undefined,
  } });
  try { return await operation(); }
  finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else Object.defineProperty(globalThis, 'crypto', { configurable: true, value: original });
  }
}

async function put(dbName: string, store: StoreName, value: unknown) {
  const db = await openLocalAttendanceDatabase(dbName);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function all<T>(dbName: string, store: StoreName): Promise<T[]> {
  const db = await openLocalAttendanceDatabase(dbName);
  const rows = await new Promise<T[]>((resolve, reject) => { const request = db.transaction(store, 'readonly').objectStore(store).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  db.close();
  return rows;
}

async function setup(now = at('2026-08-01T03:00:00Z')) {
  const dbName = `pwa-test-${crypto.randomUUID()}`;
  names.push(dbName);
  const controller = await createLocalAttendanceApi({ dbName, now: () => now });
  controllers.push(controller);
  const result = await controller.api.adminAuth.setup(command({ pin: '123456' }));
  expect(result.ok).toBe(true);
  return { dbName, controller };
}

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.close();
  for (const name of names.splice(0)) await new Promise<void>((resolve) => { const deletion = indexedDB.deleteDatabase(name); deletion.onsuccess = () => resolve(); deletion.onerror = () => resolve(); });
});

describe('PWA local API', () => {
  it('does not expose internal English errors to the PIN screen', async () => {
    const dbName = `pwa-test-${crypto.randomUUID()}`;
    names.push(dbName);
    const controller = await createLocalAttendanceApi({ dbName });
    controllers.push(controller);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
      getRandomValues: () => { throw new Error('internal crypto failure'); },
      randomUUID: undefined,
      subtle: undefined,
    } });
    try {
      const result = await controller.api.adminAuth.setup({ pin: '842091', requestId: 'hidden-error' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toBe('処理を完了できませんでした。アプリを開き直して、もう一度お試しください。');
        expect(result.message).not.toMatch(/crypto|undefined|internal/i);
      }
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
      else Object.defineProperty(globalThis, 'crypto', { configurable: true, value: original });
    }
  });

  it('sets up and verifies PIN when subtle and randomUUID are unavailable', async () => {
    const dbName = `pwa-test-${crypto.randomUUID()}`;
    names.push(dbName);
    const controller = await createLocalAttendanceApi({ dbName });
    controllers.push(controller);
    await withoutCryptoSubtle(async () => {
      expect((await controller.api.adminAuth.setup({ pin: '123456', requestId: 'fallback-setup' })).ok).toBe(true);
      await controller.api.adminAuth.lock();
      expect((await controller.api.adminAuth.verify({ pin: '123456', requestId: 'fallback-verify' })).ok).toBe(true);
      await controller.api.adminAuth.lock();
    }, true);
    expect((await controller.api.adminAuth.verify(command({ pin: '123456' }))).ok).toBe(true);
  });

  it('verifies a WebCrypto-generated PBKDF2 hash with the fallback implementation', async () => {
    const { controller } = await setup();
    await controller.api.adminAuth.lock();
    await withoutCryptoSubtle(async () => {
      expect((await controller.api.adminAuth.verify(command({ pin: '123456' }))).ok).toBe(true);
    });
  });

  it('reads v1 records with defaults and permanentlyDelete never changes data', async () => {
    const { dbName, controller } = await setup();
    await put(dbName, 'employees', { id: 'e1', name: '旧データ', hourly_wage: 1200 } satisfies LocalEmployee);
    const list = await controller.api.employees.list(true);
    expect(list.ok && list.data[0]).toMatchObject({ id: 'e1', status: 'ACTIVE', archivedAt: null });
    const deletion = await controller.api.employees.permanentlyDelete(command({ id: 'e1' }));
    expect(deletion.ok).toBe(false);
    if (!deletion.ok) expect(deletion.message).toContain('方針は未確定');
    const after = await controller.api.employees.list(true);
    expect(after.ok && after.data).toHaveLength(1);
  });

  it('stores independent wages for new employees and clock snapshots without changing legacy employees', async () => {
    const { dbName, controller } = await setup(at('2026-08-01T12:30:00Z'));
    await put(dbName, 'employees', { id: 'legacy', name: '既存', hourly_wage: 1200 } satisfies LocalEmployee);
    const created = await controller.api.employees.create(command({ name: '新規', hourlyWage: 1177, nightHourlyWage: 1471 }));
    expect(created.ok && created.data).toMatchObject({ hourlyWage: 1177, nightHourlyWage: 1471 });
    if (!created.ok) return;
    expect((await controller.api.clock.clockIn(command({ employeeId: created.data.id }))).ok).toBe(true);
    const storedEmployees = await all<LocalEmployee>(dbName, 'employees');
    expect(storedEmployees.find((row) => row.id === 'legacy')).toEqual({ id: 'legacy', name: '既存', hourly_wage: 1200 });
    expect(storedEmployees.find((row) => row.id === created.data.id)).toMatchObject({ hourly_wage: 1177, night_hourly_wage: 1471 });
    expect((await all<LocalShift>(dbName, 'shifts'))[0]).toMatchObject({ wage_snapshot: 1177, night_wage_snapshot: 1471 });
    expect((await controller.api.employees.update(command({ id: created.data.id, hourlyWage: 1200, nightHourlyWage: 1500 }))).ok).toBe(true);
    expect((await all<LocalEmployee>(dbName, 'employees')).find((row) => row.id === created.data.id)).toMatchObject({ hourly_wage: 1200, night_hourly_wage: 1500 });
    expect((await all<LocalShift>(dbName, 'shifts'))[0]).toMatchObject({ wage_snapshot: 1177, night_wage_snapshot: 1471 });
    const listed = await controller.api.employees.list(true);
    expect(listed.ok && listed.data.find((row) => row.id === 'legacy')?.nightHourlyWage).toBeNull();
  });

  it('creates an idempotent completed shift with wage snapshots and reflects it in attendance and payroll', async () => {
    const { dbName, controller } = await setup();
    await put(dbName, 'employees', { id: 'existing', name: '既存', hourly_wage: 900, status: 'ACTIVE' } satisfies LocalEmployee);
    await put(dbName, 'employees', { id: 'e1', name: '山田', hourly_wage: 1177, night_hourly_wage: 1471, status: 'ACTIVE' } satisfies LocalEmployee);
    await put(dbName, 'shifts', { id: 'existing-shift', employee_id: 'existing', business_date: '2026-07-31', clock_in: at('2026-07-31T00:00:00Z'), clock_out: at('2026-07-31T01:00:00Z'), wage_snapshot: 900 } satisfies LocalShift);
    const requestId = 'manual-shift-once';
    const input = { employeeId: 'e1', workDate: '2026-08-01', startAt: at('2026-08-01T14:00:00Z'), endAt: at('2026-08-01T20:00:00Z'), requestId };

    const first = await controller.api.attendance.createShift(input);
    const repeated = await controller.api.attendance.createShift(input);

    expect(first.ok).toBe(true);
    expect(repeated).toEqual(first);
    if (!first.ok) return;
    expect(first.data).toMatchObject({ employeeId: 'e1', employeeName: '山田', workDate: '2026-08-01', effectiveClockIn: input.startAt, effectiveClockOut: input.endAt, state: 'CALCULATED' });
    const stored = await all<LocalShift>(dbName, 'shifts');
    expect(stored).toHaveLength(2);
    expect(stored.find((row) => row.id === 'existing-shift')).toMatchObject({ employee_id: 'existing', wage_snapshot: 900 });
    expect(stored.find((row) => row.id === first.data.id)).toMatchObject({ employee_id: 'e1', business_date: '2026-08-01', clock_in: input.startAt, clock_out: input.endAt, wage_snapshot: 1177, night_wage_snapshot: 1471, calc_status: 'CALCULATED' });
    expect((await all<Record<string, unknown>>(dbName, 'logs')).filter((row) => row.kind === 'ATTENDANCE_CREATE')).toEqual([expect.objectContaining({ target_id: first.data.id, request_id: requestId })]);

    const calendar = await controller.api.attendance.calendar('2026-08');
    expect(calendar.ok && calendar.data.attendanceDates).toEqual(['2026-08-01']);
    const day = await controller.api.attendance.day('2026-08-01');
    expect(day.ok && day.data.shifts).toEqual([expect.objectContaining({ id: first.data.id })]);
    const month = await controller.api.monthly.summary('2026-08');
    expect(month.ok && month.data).toMatchObject({ attendanceCount: 1, openCount: 0, reviewCount: 0 });
    expect(month.ok && month.data.totalYen).toBeGreaterThan(0);
  });

  it('rejects invalid, archived, overlong, and closed-month manual shifts without changing existing data', async () => {
    const { dbName, controller } = await setup();
    await put(dbName, 'employees', { id: 'active', name: '在籍', hourly_wage: 1000, status: 'ACTIVE' } satisfies LocalEmployee);
    await put(dbName, 'employees', { id: 'archived', name: '削除済み', hourly_wage: 1000, status: 'ARCHIVED' } satisfies LocalEmployee);
    await put(dbName, 'shifts', { id: 'keep', employee_id: 'active', clock_in: at('2026-07-01T00:00:00Z'), clock_out: at('2026-07-01T01:00:00Z'), wage_snapshot: 1000 } satisfies LocalShift);
    await put(dbName, 'periods', { month: '2026-09', status: 'CLOSED' } satisfies LocalPeriod);
    const base = { employeeId: 'active', workDate: '2026-08-01', startAt: at('2026-08-01T00:00:00Z'), endAt: at('2026-08-01T01:00:00Z') };

    expect((await controller.api.attendance.createShift(command({ ...base, workDate: '2026/08/01' }))).ok).toBe(false);
    expect((await controller.api.attendance.createShift(command({ ...base, workDate: '2026-08-02' }))).ok).toBe(false);
    expect((await controller.api.attendance.createShift(command({ ...base, endAt: base.startAt }))).ok).toBe(false);
    expect((await controller.api.attendance.createShift(command({ ...base, endAt: base.startAt + 24 * 60 * 60 * 1000 }))).ok).toBe(false);
    expect((await controller.api.attendance.createShift(command({ ...base, employeeId: 'missing' }))).ok).toBe(false);
    expect((await controller.api.attendance.createShift(command({ ...base, employeeId: 'archived' }))).ok).toBe(false);
    expect((await controller.api.attendance.createShift(command({ employeeId: 'active', workDate: '2026-09-01', startAt: at('2026-09-01T00:00:00Z'), endAt: at('2026-09-01T01:00:00Z') }))).ok).toBe(false);
    expect(await all<LocalShift>(dbName, 'shifts')).toEqual([expect.objectContaining({ id: 'keep' })]);
  });

  it('applies and reapplies corrections immediately, including corrected wage and effective month', async () => {
    const { dbName, controller } = await setup();
    await put(dbName, 'employees', { id: 'e1', name: '山田', hourly_wage: 1000, status: 'ACTIVE' } satisfies LocalEmployee);
    await put(dbName, 'shifts', { id: 's1', employee_id: 'e1', clock_in: at('2026-07-31T14:00:00Z'), clock_out: at('2026-07-31T18:00:00Z'), wage_snapshot: 1000 } satisfies LocalShift);
    const first = await controller.api.attendance.applyCorrection(command({ shiftId: 's1', startAt: at('2026-08-01T00:00:00Z'), endAt: at('2026-08-01T03:00:00Z'), hourlyWage: 1400, nightHourlyWage: 1750, calculationMethod: 'HALF_HOUR', longShiftConfirmed: false }));
    expect(first.ok && first.data).toMatchObject({ effectiveHourlyWage: 1400, effectiveNightHourlyWage: 1750, effectiveClockIn: at('2026-08-01T00:00:00Z') });
    const second = await controller.api.attendance.applyCorrection(command({ shiftId: 's1', startAt: at('2026-08-02T00:00:00Z'), endAt: at('2026-08-02T02:00:00Z'), hourlyWage: 1500, calculationMethod: 'ACTUAL_MINUTES', longShiftConfirmed: false }));
    expect(second.ok && second.data.history).toHaveLength(2);
    expect(second.ok && second.data.effectiveNightHourlyWage).toBe(1750);
    const july = await controller.api.monthly.summary('2026-07');
    const august = await controller.api.monthly.summary('2026-08');
    expect(july.ok && july.data.attendanceCount).toBe(0);
    expect(august.ok && august.data.attendanceCount).toBe(1);
  });

  it('previews the same exact amount as save when other employee-month shifts exist', async () => {
    const { dbName, controller } = await setup();
    await put(dbName, 'employees', { id: 'e1', name: '山田', hourly_wage: 55 } satisfies LocalEmployee);
    await put(dbName, 'shifts', { id: 's1', employee_id: 'e1', clock_in: at('2026-08-01T00:00:00Z'), clock_out: at('2026-08-01T00:01:00Z'), wage_snapshot: 33 } satisfies LocalShift);
    await put(dbName, 'shifts', { id: 's2', employee_id: 'e1', clock_in: at('2026-08-02T00:00:00Z'), clock_out: at('2026-08-02T00:01:00Z'), wage_snapshot: 55 } satisfies LocalShift);
    await put(dbName, 'corrections', { id: 'c2', shift_id: 's2', start_at: at('2026-08-02T00:00:00Z'), end_at: at('2026-08-02T00:01:00Z'), hourly_wage: 55, calculation_method: 'ACTUAL_MINUTES', status: 'APPROVED', created_at: 1 } satisfies LocalCorrection);
    const input = { shiftId: 's1', startAt: at('2026-08-01T00:00:00Z'), endAt: at('2026-08-01T00:01:00Z'), hourlyWage: 33, calculationMethod: 'ACTUAL_MINUTES' as const, longShiftConfirmed: false };
    const preview = await controller.api.attendance.previewCorrection(input);
    expect(preview.ok && preview.data.after.pay?.totalYen).toBe(0.55);
    const saved = await controller.api.attendance.applyCorrection(command(input));
    expect(saved.ok && saved.data.currentPay).toEqual(preview.ok ? preview.data.after.pay : null);
  });

  it('rejects invalid correction wages and malformed PINs', async () => {
    const { dbName, controller } = await setup();
    await put(dbName, 'employees', { id: 'e1', name: '山田', hourly_wage: 1000 } satisfies LocalEmployee);
    await put(dbName, 'shifts', { id: 's1', employee_id: 'e1', clock_in: at('2026-08-01T00:00:00Z'), clock_out: at('2026-08-01T01:00:00Z'), wage_snapshot: 1000 } satisfies LocalShift);
    const invalid = { shiftId: 's1', startAt: at('2026-08-01T00:00:00Z'), endAt: at('2026-08-01T01:00:00Z'), hourlyWage: 0, calculationMethod: 'ACTUAL_MINUTES' as const, longShiftConfirmed: false };
    expect((await controller.api.attendance.previewCorrection(invalid)).ok).toBe(false);
    expect((await controller.api.attendance.applyCorrection(command(invalid))).ok).toBe(false);
    expect((await controller.api.adminAuth.verify(command({ pin: '１２３４５６' }))).ok).toBe(false);
  });

  it('voids an open shift without deleting audit records or exposing the PIN', async () => {
    const { dbName, controller } = await setup();
    await put(dbName, 'employees', { id: 'e1', name: '山田', hourly_wage: 1000 } satisfies LocalEmployee);
    await put(dbName, 'shifts', { id: 's1', employee_id: 'e1', clock_in: at('2026-08-01T01:00:00Z'), clock_out: null, wage_snapshot: 1000, calc_status: 'OPEN' } satisfies LocalShift);
    await put(dbName, 'corrections', { id: 'c1', shift_id: 's1', start_at: at('2026-08-01T01:00:00Z'), end_at: at('2026-08-01T02:00:00Z'), status: 'PENDING', created_at: 1 } satisfies LocalCorrection);
    const before = await controller.api.clock.home();
    expect(before.ok && before.data.employees[0].status).toBe('WORKING');
    const wrong = await controller.api.attendance.voidShift(command({ shiftId: 's1', adminPin: '000000' }));
    expect(wrong.ok).toBe(false);
    expect((await all<LocalShift>(dbName, 'shifts'))[0].voided_at).toBeUndefined();
    const requestId = 'void-request-without-secret';
    const result = await controller.api.attendance.voidShift({ shiftId: 's1', adminPin: '123456', requestId });
    expect(result.ok).toBe(true);
    const rawShift = (await all<LocalShift>(dbName, 'shifts'))[0];
    expect(rawShift).toMatchObject({ id: 's1' });
    expect(rawShift.void_reason).toBeUndefined();
    expect(typeof rawShift.voided_at).toBe('number');
    expect((await controller.api.attendance.voidShift(command({ shiftId: 's1', adminPin: '123456' }))).ok).toBe(false);
    expect(await all<LocalCorrection>(dbName, 'corrections')).toEqual([expect.objectContaining({ id: 'c1', shift_id: 's1' })]);
    const home = await controller.api.clock.home();
    expect(home.ok && home.data.employees[0].status).toBe('ACTIVE');
    const status = await controller.api.clock.status('e1');
    expect(status.ok && status.data.status).toBe('READY_TO_CLOCK_IN');
    const calendar = await controller.api.attendance.calendar('2026-08');
    expect(calendar.ok && calendar.data.attendanceDates).toEqual([]);
    const day = await controller.api.attendance.day('2026-08-01');
    expect(day.ok && day.data.totals.attendanceCount).toBe(0);
    const monthly = await controller.api.monthly.summary('2026-08');
    expect(monthly.ok && monthly.data).toMatchObject({ attendanceCount: 0, totalYen: 0 });
    const correctionList = await controller.api.attendance.correctionShifts('e1');
    expect(correctionList.ok && correctionList.data).toEqual([]);
    expect((await controller.api.attendance.correctionDetail('s1')).ok).toBe(false);
    expect((await controller.api.attendance.resolveLegacyCorrection(command({ correctionId: 'c1', action: 'REJECT' }))).ok).toBe(false);
    const logs = await all<Record<string, unknown>>(dbName, 'logs');
    expect(logs).toContainEqual(expect.objectContaining({ kind: 'ATTENDANCE_VOID', target_id: 's1', request_id: requestId }));
    const receipts = await all<Record<string, unknown>>(dbName, 'receipts');
    expect(JSON.stringify({ logs, receipts })).not.toContain('123456');
    const backup = await controller.api.backup.create(command({ kind: 'MANUAL' as const }));
    expect(backup.ok).toBe(true);
    const exported = backup.ok ? await controller.api.backup.export(backup.data.id) : null;
    expect(exported?.ok && exported.data.json).toContain('voided_at');
    expect(exported?.ok && exported.data.json).not.toContain('123456');
  });

  it('rejects voiding an effective shift in a closed month', async () => {
    const { dbName, controller } = await setup();
    await put(dbName, 'employees', { id: 'e1', name: '山田', hourly_wage: 1000 } satisfies LocalEmployee);
    await put(dbName, 'shifts', { id: 's1', employee_id: 'e1', clock_in: at('2026-07-31T14:00:00Z'), clock_out: at('2026-07-31T18:00:00Z'), wage_snapshot: 1000 } satisfies LocalShift);
    await put(dbName, 'corrections', { id: 'c1', shift_id: 's1', start_at: at('2026-08-01T01:00:00Z'), end_at: at('2026-08-01T03:00:00Z'), status: 'APPROVED', created_at: 1 } satisfies LocalCorrection);
    await put(dbName, 'periods', { month: '2026-08', status: 'CLOSED' } satisfies LocalPeriod);
    const result = await controller.api.attendance.voidShift(command({ shiftId: 's1', adminPin: '123456' }));
    expect(result.ok).toBe(false);
    expect((await all<LocalShift>(dbName, 'shifts'))[0].voided_at).toBeUndefined();
  });

  it('applies PIN failure lockout to voidShift reauthentication', async () => {
    const { dbName, controller } = await setup();
    await put(dbName, 'employees', { id: 'e1', name: '山田', hourly_wage: 1000 } satisfies LocalEmployee);
    await put(dbName, 'shifts', { id: 's1', employee_id: 'e1', clock_in: at('2026-08-01T01:00:00Z'), clock_out: null, wage_snapshot: 1000 } satisfies LocalShift);
    for (let index = 0; index < 5; index += 1) expect((await controller.api.attendance.voidShift(command({ shiftId: 's1', adminPin: '000000' }))).ok).toBe(false);
    const locked = await controller.api.attendance.voidShift(command({ shiftId: 's1', adminPin: '123456' }));
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.message).toContain('ロック');
    expect((await all<LocalShift>(dbName, 'shifts'))[0].voided_at).toBeUndefined();
  });

  it('archives an employee after their open shift is voided', async () => {
    const { dbName, controller } = await setup();
    await put(dbName, 'employees', { id: 'e1', name: '山田', hourly_wage: 1000 } satisfies LocalEmployee);
    await put(dbName, 'shifts', { id: 's1', employee_id: 'e1', clock_in: at('2026-08-01T01:00:00Z'), clock_out: null, wage_snapshot: 1000 } satisfies LocalShift);
    expect((await controller.api.employees.archive(command({ id: 'e1' }))).ok).toBe(false);
    expect((await controller.api.attendance.voidShift(command({ shiftId: 's1', adminPin: '123456' }))).ok).toBe(true);
    const archived = await controller.api.employees.archive(command({ id: 'e1' }));
    expect(archived.ok && archived.data.status).toBe('ARCHIVED');
  });

  it('rejects corrections when either the source or destination month is closed', async () => {
    const { dbName, controller } = await setup();
    await put(dbName, 'employees', { id: 'e1', name: '山田', hourly_wage: 1000 } satisfies LocalEmployee);
    await put(dbName, 'shifts', { id: 's1', employee_id: 'e1', clock_in: at('2026-07-20T00:00:00Z'), clock_out: at('2026-07-20T04:00:00Z'), wage_snapshot: 1000 } satisfies LocalShift);
    await put(dbName, 'periods', { month: '2026-08', status: 'CLOSED' } satisfies LocalPeriod);
    const result = await controller.api.attendance.applyCorrection(command({ shiftId: 's1', startAt: at('2026-08-02T00:00:00Z'), endAt: at('2026-08-02T03:00:00Z'), hourlyWage: 1000, calculationMethod: 'HALF_HOUR', longShiftConfirmed: false }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('移動元または移動先');
  });

  it('resolves legacy PENDING and blocks close while pending/open/review exists', async () => {
    const { dbName, controller } = await setup();
    await put(dbName, 'employees', { id: 'e1', name: '山田', hourly_wage: 1000 } satisfies LocalEmployee);
    await put(dbName, 'shifts', { id: 's1', employee_id: 'e1', clock_in: at('2026-08-01T00:00:00Z'), clock_out: at('2026-08-01T04:00:00Z'), wage_snapshot: 1000 } satisfies LocalShift);
    await put(dbName, 'corrections', { id: 'c1', shift_id: 's1', start_at: at('2026-08-01T00:30:00Z'), end_at: at('2026-08-01T04:00:00Z'), status: 'PENDING', created_at: 1 } satisfies LocalCorrection);
    const blocked = await controller.api.monthly.summary('2026-08');
    expect(blocked.ok && blocked.data).toMatchObject({ legacyPendingCount: 1, canClose: false });
    const applied = await controller.api.attendance.resolveLegacyCorrection(command({ correctionId: 'c1', action: 'APPLY' }));
    expect(applied.ok && applied.data.effectiveClockIn).toBe(at('2026-08-01T00:30:00Z'));
    const close = await controller.api.monthly.close(command({ month: '2026-08' }));
    expect(close.ok && close.data.status).toBe('CLOSED');
  });

  it('creates one AUTO per JST day, exports v2, and restores v1 without replacing admin auth', async () => {
    const { dbName, controller } = await setup();
    await controller.ensureAutoBackup();
    await controller.ensureAutoBackup();
    const list = await controller.api.backup.list();
    expect(list.ok && list.data.filter((x) => x.kind === 'AUTO')).toHaveLength(1);
    const exported = JSON.parse(await controller.exportBackupJson());
    expect(exported.version).toBe(2);
    exported.version = 1;
    const incomingAdmin = exported.stores.meta.find((x: { key?: string }) => x.key === 'administrator');
    incomingAdmin.value.pinHash = 'malicious';
    const restored = await controller.importBackupJson(JSON.stringify(exported));
    expect(restored).toEqual({ ok: true, data: { imported: true, requiresReauthentication: true } });
    const locked = await controller.api.employees.list();
    expect(locked.ok).toBe(false);
    const verified = await controller.api.adminAuth.verify(command({ pin: '123456' }));
    expect(verified.ok).toBe(true);
    const backups = await all<LocalBackup>(dbName, 'backups');
    expect(backups.some((x) => x.kind === 'PRE_RESTORE')).toBe(true);
  });

  it('rejects missing required stores and required fields before restore', async () => {
    const { controller } = await setup();
    const missingStore = JSON.parse(await controller.exportBackupJson());
    delete missingStore.stores.shifts;
    expect((await controller.importBackupJson(JSON.stringify(missingStore))).ok).toBe(false);
    const missingField = JSON.parse(await controller.exportBackupJson());
    missingField.stores.employees.push({ id: 'broken', name: '壊れたデータ' });
    expect((await controller.importBackupJson(JSON.stringify(missingField))).ok).toBe(false);
  });

  it('migrates a minimal v1 fixture by defaulting omitted stores', async () => {
    const { dbName, controller } = await setup();
    const fixture = {
      format: 'local-attendance-pwa-backup', version: 1, exportedAt: at('2025-01-01T00:00:00Z'),
      stores: { employees: [{ id: 'v1-employee', name: '旧形式', hourly_wage: 900 }], shifts: [] },
    };
    const result = await controller.importBackupJson(JSON.stringify(fixture));
    expect(result.ok).toBe(true);
    expect(await all<LocalEmployee>(dbName, 'employees')).toEqual([expect.objectContaining({ id: 'v1-employee' })]);
    expect((await controller.api.adminAuth.verify(command({ pin: '123456' }))).ok).toBe(true);
  });

  it('rejects duplicate keys without changing existing data', async () => {
    const { dbName, controller } = await setup();
    await put(dbName, 'employees', { id: 'keep', name: '既存', hourly_wage: 1000 } satisfies LocalEmployee);
    const payload = JSON.parse(await controller.exportBackupJson());
    payload.stores.employees = [
      { id: 'duplicate', name: '一件目', hourly_wage: 1000 },
      { id: 'duplicate', name: '二件目', hourly_wage: 1200 },
    ];
    const result = await controller.importBackupJson(JSON.stringify(payload));
    expect(result.ok).toBe(false);
    expect(await all<LocalEmployee>(dbName, 'employees')).toEqual([expect.objectContaining({ id: 'keep', name: '既存' })]);
  });

  it('rolls back replaced stores when IndexedDB fails midway through the transaction', async () => {
    const { dbName, controller } = await setup();
    await put(dbName, 'employees', { id: 'keep', name: '既存', hourly_wage: 1000 } satisfies LocalEmployee);
    const payload = JSON.parse(await controller.exportBackupJson());
    payload.stores.employees = [{ id: 'replacement', name: '置換予定', hourly_wage: 1200 }];
    payload.stores.logs.push({ id: 'force-failure', created_at: 1, kind: 'TEST', result: 'SUCCESS' });
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'logs' && (value as { id?: string })?.id === 'force-failure') throw new DOMException('injected failure', 'DataError');
      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    };
    try {
      expect((await controller.importBackupJson(JSON.stringify(payload))).ok).toBe(false);
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
    expect(await all<LocalEmployee>(dbName, 'employees')).toEqual([expect.objectContaining({ id: 'keep', name: '既存' })]);
  });

  it('deletes only internal backups older than 90 JST days', async () => {
    const now = at('2026-08-01T03:00:00Z');
    const { dbName, controller } = await setup(now);
    const snapshot = JSON.parse(await controller.exportBackupJson());
    await put(dbName, 'backups', { id: 'old', file_name: 'old.json', kind: 'MANUAL', status: 'SUCCESS', size: 1, created_at: now - 91 * 86_400_000, snapshot } satisfies LocalBackup);
    await put(dbName, 'backups', { id: 'boundary', file_name: 'boundary.json', kind: 'MANUAL', status: 'SUCCESS', size: 1, created_at: now - 90 * 86_400_000, snapshot } satisfies LocalBackup);
    await controller.ensureAutoBackup();
    const ids = (await all<LocalBackup>(dbName, 'backups')).map((x) => x.id);
    expect(ids).not.toContain('old');
    expect(ids).toContain('boundary');
  });

  it('records quota failure without changing attendance data', async () => {
    const { dbName, controller } = await setup();
    await put(dbName, 'employees', { id: 'keep', name: '既存従業員', hourly_wage: 1000 } satisfies LocalEmployee);
    const before = await all<LocalEmployee>(dbName, 'employees');
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'backups') throw new DOMException('storage quota exceeded', 'QuotaExceededError');
      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    };
    let result;
    try {
      result = await controller.api.backup.create(command({ kind: 'MANUAL' as const }));
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
    expect(result?.ok).toBe(false);
    expect(await all<LocalEmployee>(dbName, 'employees')).toEqual(before);
    const status = await controller.api.backup.status();
    expect(status.ok && status.data.lastFailureAt).not.toBeNull();
    expect(status.ok && status.data.lastFailure).toContain('storage quota exceeded');
  });

  it('returns exact shift and day decimals while keeping employee-month half-up totals', async () => {
    const { dbName, controller } = await setup();
    await put(dbName, 'employees', { id: 'e1', name: '山田', hourly_wage: 1177, night_hourly_wage: 1471 } satisfies LocalEmployee);
    await put(dbName, 'shifts', { id: 's1', employee_id: 'e1', clock_in: at('2026-08-01T00:00:00Z'), clock_out: at('2026-08-01T00:30:00Z'), wage_snapshot: 1177, night_wage_snapshot: 1471 } satisfies LocalShift);

    const day = await controller.api.attendance.day('2026-08-01');
    expect(day.ok && day.data.shifts[0].pay).toMatchObject({ regularYen: 588.5, nightYen: 0, totalYen: 588.5 });
    expect(day.ok && day.data.totals.totalYen).toBe(588.5);

    const employee = await controller.api.monthly.employeeDetail('2026-08', 'e1');
    expect(employee.ok && employee.data.days[0].totals.totalYen).toBe(588.5);
    expect(employee.ok && employee.data.totals.totalYen).toBe(589);
    const month = await controller.api.monthly.summary('2026-08');
    expect(month.ok && month.data).toMatchObject({ regularYen: 589, nightYen: 0, totalYen: 589 });

    const csv = await controller.api.monthly.exportCsv('2026-08');
    expect(csv.ok).toBe(true);
    if (csv.ok) {
      const lines = csv.data.csv.replace(/^\uFEFF/, '').split('\r\n');
      expect(lines.find((line) => line.startsWith('"明細"'))).toContain('"588.5"');
      expect(lines.find((line) => line.startsWith('"従業員合計"'))).toContain('"589"');
      expect(lines.find((line) => line.startsWith('"月全体合計"'))).toContain('"589"');
    }
  });

  it('uses an independent night snapshot and preserves the legacy 25 percent fallback', async () => {
    const { dbName, controller } = await setup();
    await put(dbName, 'employees', { id: 'explicit', name: '新方式', hourly_wage: 1177, night_hourly_wage: 1471 } satisfies LocalEmployee);
    await put(dbName, 'employees', { id: 'legacy', name: '旧方式', hourly_wage: 1177 } satisfies LocalEmployee);
    const clockIn = at('2026-08-01T12:30:00Z');
    const clockOut = at('2026-08-01T13:30:00Z');
    await put(dbName, 'shifts', { id: 'explicit-shift', employee_id: 'explicit', clock_in: clockIn, clock_out: clockOut, wage_snapshot: 1177, night_wage_snapshot: 1471 } satisfies LocalShift);
    await put(dbName, 'shifts', { id: 'legacy-shift', employee_id: 'legacy', clock_in: clockIn, clock_out: clockOut, wage_snapshot: 1177 } satisfies LocalShift);
    const day = await controller.api.attendance.day('2026-08-01');
    expect(day.ok).toBe(true);
    if (day.ok) {
      expect(day.data.shifts.find((row) => row.id === 'explicit-shift')?.pay).toMatchObject({ regularYen: 588.5, nightYen: 735.5, totalYen: 1324 });
      expect(day.data.shifts.find((row) => row.id === 'legacy-shift')?.pay).toMatchObject({ regularYen: 588.5, nightYen: 735.625, totalYen: 1324.125 });
    }
  });

  it('returns BOM CSV with detail, employee total, month total and disclaimer', async () => {
    const { dbName, controller } = await setup();
    await put(dbName, 'employees', { id: 'e1', name: '=山田', hourly_wage: 1000 } satisfies LocalEmployee);
    await put(dbName, 'shifts', { id: 's1', employee_id: 'e1', clock_in: at('2026-08-01T00:00:00Z'), clock_out: at('2026-08-01T04:00:00Z'), wage_snapshot: 1000 } satisfies LocalShift);
    const result = await controller.api.monthly.exportCsv('2026-08');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.csv.startsWith('\uFEFF')).toBe(true);
      expect(result.data.csv).toContain('明細');
      expect(result.data.csv).toContain('従業員合計');
      expect(result.data.csv).toContain('月全体合計');
      expect(result.data.csv).toContain('※残業・休日割増は含まれていません');
      expect(result.data.csv).toContain("'=山田");
    }
  });
});

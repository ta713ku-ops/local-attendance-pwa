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
  it('aggregates month and year by the corrected JST clock-in date without double counting boundaries', async () => {
    const { dbName, controller } = await setup();
    await put(dbName, 'employees', { id: 'e-boundary', name: '境界 花子', hourly_wage: 1200, night_hourly_wage: 1500, status: 'ACTIVE' } satisfies LocalEmployee);
    const shifts: LocalShift[] = [
      { id: 'aug-cross', employee_id: 'e-boundary', business_date: '2026-09-01', clock_in: at('2026-09-01T00:00:00Z'), clock_out: at('2026-09-01T01:00:00Z'), wage_snapshot: 1200, night_wage_snapshot: 1500, calc_status: 'CALCULATED', created_at: at('2026-09-01T00:00:00Z') },
      { id: 'dec-cross', employee_id: 'e-boundary', business_date: '2026-12-31', clock_in: at('2026-12-31T13:00:00Z'), clock_out: at('2026-12-31T20:00:00Z'), wage_snapshot: 1200, night_wage_snapshot: 1500, calc_status: 'CALCULATED', created_at: at('2026-12-31T13:00:00Z') },
      { id: 'jan-shift', employee_id: 'e-boundary', business_date: '2026-01-10', clock_in: at('2026-01-10T00:00:00Z'), clock_out: at('2026-01-10T08:00:00Z'), wage_snapshot: 1200, night_wage_snapshot: 1500, calc_status: 'CALCULATED', created_at: at('2026-01-10T00:00:00Z') },
    ];
    for (const shift of shifts) await put(dbName, 'shifts', shift);
    await put(dbName, 'corrections', { id: 'aug-cross-correction', shift_id: 'aug-cross', start_at: at('2026-08-31T13:00:00Z'), end_at: at('2026-08-31T20:00:00Z'), hourly_wage: 1200, night_hourly_wage: 1500, reason: '実効出勤時刻の境界確認', calculation_method: 'HALF_HOUR', long_shift_confirmed: false, status: 'APPROVED', applied_at: at('2026-09-02T00:00:00Z'), created_at: at('2026-09-02T00:00:00Z') } satisfies LocalCorrection);

    const august = await controller.api.monthly.summary('2026-08');
    const september = await controller.api.monthly.summary('2026-09');
    const december = await controller.api.monthly.summary('2026-12');
    const january2027 = await controller.api.monthly.summary('2027-01');
    expect(august.ok && august.data.employees[0]).toMatchObject({ employeeId: 'e-boundary', attendanceCount: 1, totalMinutes: 420, regularMinutes: 0, nightMinutes: 420 });
    expect(september.ok && september.data.attendanceCount).toBe(0);
    expect(december.ok && december.data.employees[0]).toMatchObject({ attendanceCount: 1, totalMinutes: 420, regularMinutes: 0, nightMinutes: 420 });
    expect(january2027.ok && january2027.data.attendanceCount).toBe(0);

    const annual = await controller.api.annual.summary('2026');
    expect(annual.ok && annual.data.employees[0]).toMatchObject({ employeeId: 'e-boundary', attendanceCount: 3, totalMinutes: 1320, regularMinutes: 480, nightMinutes: 840 });
    if (!annual.ok || !august.ok || !december.ok) throw new Error('expected summaries');
    expect(annual.data.employees[0].totalYen).toBe(annual.data.employees[0].regularYen + annual.data.employees[0].nightYen);
    expect(annual.data.employees[0].totalYen).toBe((await controller.api.monthly.summary('2026-01')).data!.employees[0].totalYen + august.data.employees[0].totalYen + december.data.employees[0].totalYen);

    const detail = await controller.api.annual.employeeDetail('2026', 'e-boundary');
    expect(detail.ok && detail.data.months).toHaveLength(12);
    expect(detail.ok && detail.data.months.find((value) => value.month === '2026-08')).toMatchObject({ attendanceCount: 1, totalMinutes: 420, totalYen: august.data.employees[0].totalYen });
    expect(detail.ok && detail.data.months.find((value) => value.month === '2026-09')).toMatchObject({ attendanceCount: 0, totalMinutes: 0, totalYen: 0 });
  });

  it('strictly validates annual aggregate year input', async () => {
    const { controller } = await setup();
    for (const year of ['26', '2026-01', '２０２６', '202a', ' 2026']) {
      const result = await controller.api.annual.summary(year);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('対象年');
    }
  });

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

  it('bulk-updates only active current wages without changing historical pay, snapshots, or a restorable backup', async () => {
    const { dbName, controller } = await setup(at('2026-08-10T00:00:00Z'));
    const employees: LocalEmployee[] = [
      { id: 'active', name: '在籍', hourly_wage: 1000, night_hourly_wage: 1250, status: 'ACTIVE' },
      { id: 'legacy', name: '旧形式', hourly_wage: 1100 },
      { id: 'archived', name: '削除済み', hourly_wage: 1200, night_hourly_wage: 1500, status: 'ARCHIVED' },
    ];
    for (const employee of employees) await put(dbName, 'employees', employee);
    const historical: LocalShift = { id: 'historical', employee_id: 'active', business_date: '2026-08-01', clock_in: at('2026-08-01T12:30:00Z'), clock_out: at('2026-08-01T15:30:00Z'), wage_snapshot: 1000, night_wage_snapshot: 1250, calc_status: 'CALCULATED', created_at: at('2026-08-01T12:30:00Z') };
    await put(dbName, 'shifts', historical);

    const before = {
      month: await controller.api.monthly.summary('2026-08'),
      annual: await controller.api.annual.summary('2026'),
      csv: await controller.api.monthly.exportCsv('2026-08'),
      print: await controller.api.monthly.print('2026-08'),
      backup: await controller.api.backup.prepareExport(),
      employees: await all<LocalEmployee>(dbName, 'employees'),
      shifts: await all<LocalShift>(dbName, 'shifts'),
    };
    expect(before.backup.ok).toBe(true);

    for (const hourlyWage of [0, -1, 1000.5, Number.NaN]) {
      expect((await controller.api.employees.bulkUpdateWages(command({ hourlyWage, nightHourlyWage: 1800 }))).ok).toBe(false);
    }
    for (const nightHourlyWage of [0, -1, 1800.5, Number.NaN]) {
      expect((await controller.api.employees.bulkUpdateWages(command({ hourlyWage: 1400, nightHourlyWage }))).ok).toBe(false);
    }
    expect(await all<LocalEmployee>(dbName, 'employees')).toEqual(before.employees);
    expect(await all<LocalShift>(dbName, 'shifts')).toEqual(before.shifts);
    expect((await all<Record<string, unknown>>(dbName, 'logs')).filter((row) => row.kind === 'EMPLOYEE_BULK_WAGE_UPDATE')).toHaveLength(0);

    const requestId = 'bulk-wage-update-once';
    const input = { hourlyWage: 1400, nightHourlyWage: 1800, requestId };
    const first = await controller.api.employees.bulkUpdateWages(input);
    const repeated = await controller.api.employees.bulkUpdateWages(input);
    expect(first).toEqual({ ok: true, data: { updatedCount: 2 } });
    expect(repeated).toEqual(first);
    expect(await all<LocalEmployee>(dbName, 'employees')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'active', hourly_wage: 1400, night_hourly_wage: 1800 }),
      expect.objectContaining({ id: 'legacy', hourly_wage: 1400, night_hourly_wage: 1800 }),
      expect.objectContaining({ id: 'archived', hourly_wage: 1200, night_hourly_wage: 1500, status: 'ARCHIVED' }),
    ]));
    expect((await all<LocalShift>(dbName, 'shifts')).find((row) => row.id === historical.id)).toEqual(historical);
    expect((await all<Record<string, unknown>>(dbName, 'logs')).filter((row) => row.kind === 'EMPLOYEE_BULK_WAGE_UPDATE')).toEqual([
      expect.objectContaining({ request_id: requestId, result: 'SUCCESS' }),
    ]);

    expect(await controller.api.monthly.summary('2026-08')).toEqual(before.month);
    expect(await controller.api.annual.summary('2026')).toEqual(before.annual);
    expect(await controller.api.monthly.exportCsv('2026-08')).toEqual(before.csv);
    expect(await controller.api.monthly.print('2026-08')).toEqual(before.print);

    const clockIn = await controller.api.clock.clockIn(command({ employeeId: 'active' }));
    expect(clockIn.ok).toBe(true);
    const created = await controller.api.attendance.createShift(command({ employeeId: 'legacy', workDate: '2026-08-11', startAt: at('2026-08-11T00:00:00Z'), endAt: at('2026-08-11T01:00:00Z') }));
    expect(created.ok).toBe(true);
    const postUpdateShifts = await all<LocalShift>(dbName, 'shifts');
    expect(postUpdateShifts.find((row) => row.id === (clockIn.ok ? clockIn.data.shiftId : ''))).toMatchObject({ wage_snapshot: 1400, night_wage_snapshot: 1800 });
    expect(postUpdateShifts.find((row) => row.id === (created.ok ? created.data.id : ''))).toMatchObject({ wage_snapshot: 1400, night_wage_snapshot: 1800 });

    if (!before.backup.ok) throw new Error('expected backup export');
    expect((await controller.api.backup.restoreImport(command({ json: before.backup.data.json }))).ok).toBe(true);
    expect(await all<LocalEmployee>(dbName, 'employees')).toEqual(before.employees);
    expect(await all<LocalShift>(dbName, 'shifts')).toEqual(before.shifts);
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
    const backup = await controller.api.backup.prepareExport();
    expect(backup.ok).toBe(true);
    expect(backup.ok && backup.data.json).toContain('voided_at');
    expect(backup.ok && backup.data.json).not.toContain('123456');
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

  it('prepares a v2 file without auth or backup-status meta, and records only a confirmed save', async () => {
    const { dbName, controller } = await setup();
    await put(dbName, 'meta', { key: 'backupLastSuccessAt', value: 1 });
    await put(dbName, 'backups', { id: 'legacy-backup', file_name: 'legacy.json', kind: 'MANUAL', status: 'SUCCESS', size: 1, created_at: 1 } satisfies LocalBackup);
    const prepared = await controller.api.backup.prepareExport();
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error('expected prepared export');
    const exported = JSON.parse(prepared.data.json);
    expect(exported.version).toBe(2);
    expect(exported.stores.meta.some((row: { key?: string }) => row.key === 'administrator')).toBe(false);
    expect(exported.stores.meta.some((row: { key?: string }) => row.key?.startsWith('backupLast'))).toBe(false);
    expect(prepared.data.fileName).toBe('backup_2026-08-01_1200.json');
    expect((await controller.api.backup.status()).data).toEqual({ lastBackupAt: null });
    expect((await controller.api.backup.markExportSaved(command({ createdAt: prepared.data.createdAt }))).data).toEqual({ lastBackupAt: prepared.data.createdAt });
    expect((await controller.api.backup.status()).data).toEqual({ lastBackupAt: prepared.data.createdAt });
    expect((await controller.api.backup.markExportSaved(command({ createdAt: prepared.data.createdAt }))).ok).toBe(false);
    expect(await all<LocalBackup>(dbName, 'backups')).toEqual([expect.objectContaining({ id: 'legacy-backup' })]);
  });

  it('keeps admin authentication until it is explicitly locked', async () => {
    let current = at('2026-08-01T03:00:00Z');
    const dbName = `pwa-test-${crypto.randomUUID()}`;
    names.push(dbName);
    const controller = await createLocalAttendanceApi({ dbName, now: () => current });
    controllers.push(controller);
    expect((await controller.api.adminAuth.setup(command({ pin: '123456' }))).ok).toBe(true);
    current += 6 * 60_000;
    expect((await controller.api.employees.list()).ok).toBe(true);
    await controller.api.adminAuth.lock();
    expect((await controller.api.employees.list()).ok).toBe(false);
  });

  it('rejects missing required stores and required fields before restore', async () => {
    const { controller } = await setup();
    const prepared = await controller.api.backup.prepareExport();
    if (!prepared.ok) throw new Error('expected prepared export');
    const missingStore = JSON.parse(prepared.data.json);
    delete missingStore.stores.shifts;
    expect((await controller.api.backup.inspectImport(JSON.stringify(missingStore))).ok).toBe(false);
    const missingField = JSON.parse(prepared.data.json);
    missingField.stores.employees.push({ id: 'broken', name: '壊れたデータ' });
    expect((await controller.api.backup.inspectImport(JSON.stringify(missingField))).ok).toBe(false);
  });

  it('migrates a minimal v1 fixture by defaulting omitted stores', async () => {
    const { dbName, controller } = await setup();
    const fixture = {
      format: 'local-attendance-pwa-backup', version: 1, exportedAt: at('2025-01-01T00:00:00Z'),
      stores: { employees: [{ id: 'v1-employee', name: '旧形式', hourly_wage: 900 }], shifts: [] },
    };
    const result = await controller.api.backup.restoreImport(command({ json: JSON.stringify(fixture) }));
    expect(result.ok).toBe(true);
    expect(await all<LocalEmployee>(dbName, 'employees')).toEqual([expect.objectContaining({ id: 'v1-employee' })]);
    expect((await controller.api.adminAuth.verify(command({ pin: '123456' }))).ok).toBe(true);
  });

  it('rejects duplicate keys without changing existing data', async () => {
    const { dbName, controller } = await setup();
    await put(dbName, 'employees', { id: 'keep', name: '既存', hourly_wage: 1000 } satisfies LocalEmployee);
    const prepared = await controller.api.backup.prepareExport();
    if (!prepared.ok) throw new Error('expected prepared export');
    const payload = JSON.parse(prepared.data.json);
    payload.stores.employees = [
      { id: 'duplicate', name: '一件目', hourly_wage: 1000 },
      { id: 'duplicate', name: '二件目', hourly_wage: 1200 },
    ];
    const result = await controller.api.backup.restoreImport(command({ json: JSON.stringify(payload) }));
    expect(result.ok).toBe(false);
    expect(await all<LocalEmployee>(dbName, 'employees')).toEqual([expect.objectContaining({ id: 'keep', name: '既存' })]);
  });

  it('rolls back replaced stores when IndexedDB fails midway through the transaction', async () => {
    const { dbName, controller } = await setup();
    await put(dbName, 'employees', { id: 'keep', name: '既存', hourly_wage: 1000 } satisfies LocalEmployee);
    const prepared = await controller.api.backup.prepareExport();
    if (!prepared.ok) throw new Error('expected prepared export');
    const payload = JSON.parse(prepared.data.json);
    payload.stores.employees = [{ id: 'replacement', name: '置換予定', hourly_wage: 1200 }];
    payload.stores.logs.push({ id: 'force-failure', created_at: 1, kind: 'TEST', result: 'SUCCESS' });
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'logs' && (value as { id?: string })?.id === 'force-failure') throw new DOMException('injected failure', 'DataError');
      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    };
    try {
      expect((await controller.api.backup.restoreImport(command({ json: JSON.stringify(payload) }))).ok).toBe(false);
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
    expect(await all<LocalEmployee>(dbName, 'employees')).toEqual([expect.objectContaining({ id: 'keep', name: '既存' })]);
  });

  it('inspects before restoring, preserves auth and last backup time, then locks after restore', async () => {
    const { dbName, controller } = await setup();
    await put(dbName, 'employees', { id: 'keep', name: '現在のデータ', hourly_wage: 1000 } satisfies LocalEmployee);
    await put(dbName, 'backups', { id: 'legacy-backup', file_name: 'legacy.json', kind: 'MANUAL', status: 'SUCCESS', size: 1, created_at: 1 } satisfies LocalBackup);
    const prepared = await controller.api.backup.prepareExport();
    if (!prepared.ok) throw new Error('expected prepared export');
    await controller.api.backup.markExportSaved(command({ createdAt: prepared.data.createdAt }));
    const payload = JSON.parse(prepared.data.json);
    payload.version = 1;
    payload.stores.employees = [{ id: 'restored', name: '復元データ', hourly_wage: 1200 }];
    payload.stores.meta.push({ key: 'administrator', value: { pinHash: 'malicious' } });
    payload.stores.meta.push({ key: 'backupLastExportedAt', value: 1 });
    expect((await controller.api.backup.inspectImport(JSON.stringify(payload))).data).toEqual({ createdAt: prepared.data.createdAt });
    expect(await all<LocalEmployee>(dbName, 'employees')).toEqual([expect.objectContaining({ id: 'keep' })]);
    expect((await controller.api.backup.restoreImport(command({ json: JSON.stringify(payload) }))).ok).toBe(true);
    expect(await all<LocalEmployee>(dbName, 'employees')).toEqual([expect.objectContaining({ id: 'restored' })]);
    expect((await controller.api.employees.list()).ok).toBe(false);
    expect((await controller.api.adminAuth.verify(command({ pin: '123456' }))).ok).toBe(true);
    expect((await controller.api.backup.status()).data).toEqual({ lastBackupAt: prepared.data.createdAt });
    expect(await all<LocalBackup>(dbName, 'backups')).toEqual([expect.objectContaining({ id: 'legacy-backup' })]);
  });

  it('rejects invalid import times and never rolls the last backup time backward', async () => {
    let current = at('2026-08-01T03:00:00Z');
    const dbName = `pwa-test-${crypto.randomUUID()}`;
    names.push(dbName);
    const controller = await createLocalAttendanceApi({ dbName, now: () => current });
    controllers.push(controller);
    expect((await controller.api.adminAuth.setup(command({ pin: '123456' }))).ok).toBe(true);
    const first = await controller.api.backup.prepareExport();
    if (!first.ok) throw new Error('expected prepared export');
    await controller.api.backup.markExportSaved(command({ createdAt: first.data.createdAt }));
    current -= 60_000;
    const stale = await controller.api.backup.prepareExport();
    if (!stale.ok) throw new Error('expected prepared export');
    expect((await controller.api.backup.markExportSaved(command({ createdAt: stale.data.createdAt }))).ok).toBe(false);
    expect((await controller.api.backup.status()).data).toEqual({ lastBackupAt: first.data.createdAt });
    const invalid = JSON.parse(stale.data.json);
    invalid.exportedAt = 0;
    expect((await controller.api.backup.inspectImport(JSON.stringify(invalid))).ok).toBe(false);
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

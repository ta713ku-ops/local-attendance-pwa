import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import { z } from 'zod';
import { calculateShift, summarizeEmployeeMonth, type CalculatedShift, type MonthlyShift } from '../domain';
import { Store, type AppResult } from './database';
import { permanentlyDeleteEmployee } from './employees';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

let mainWindow: BrowserWindow | undefined;
let store: Store;
const baseCommand = z.object({ requestId: z.string().uuid() });
const employeeCommand = baseCommand.extend({ employeeId: z.string().uuid() });
const ok = <T>(data: T): AppResult<T> => ({ ok: true, data });

function assertSender(event: Electron.IpcMainInvokeEvent) {
  if (!mainWindow || event.senderFrame?.url !== mainWindow.webContents.mainFrame.url) throw new Error('Unauthorized IPC sender');
}

function readHandler<T>(channel: string, handler: (argument: unknown) => T | Promise<T>, admin = true) {
  ipcMain.handle(channel, async (event, argument) => {
    try {
      assertSender(event);
      if (admin) store.requireAdmin();
      return ok(await handler(argument));
    } catch (error) {
      return { ok: false, code: 'OPERATION_FAILED', message: error instanceof Error ? error.message : '操作に失敗しました。', needsAuth: admin };
    }
  });
}

function commandHandler<T extends z.ZodTypeAny>(channel: string, schema: T, handler: (value: z.infer<T>) => unknown, admin = true, automaticBackup = false) {
  ipcMain.handle(channel, async (event, argument) => {
    try {
      assertSender(event);
      if (admin) store.requireAdmin();
      const value = schema.parse(argument);
      const result = store.runCommand(value.requestId, channel, () => handler(value));
      const { replayed, ...clientResult } = result;
      if (clientResult.ok && automaticBackup && !replayed) {
        try { await store.backup(channel.replace(':', '_').toUpperCase()); }
        catch (error) { return { ...clientResult, backupWarning: error instanceof Error ? error.message : 'バックアップに失敗しました。' }; }
      }
      return clientResult;
    } catch (error) {
      return { ok: false, code: 'OPERATION_FAILED', message: error instanceof Error ? error.message : '操作に失敗しました。', needsAuth: admin };
    }
  });
}

function effectiveCalculation(row: any): CalculatedShift | null {
  if (row.clock_out == null) return null;
  const correction = store.db.prepare("SELECT start_at,end_at FROM attendance_corrections WHERE shift_id=? AND status='APPROVED' ORDER BY created_at DESC LIMIT 1").get(row.id) as any;
  const exception = store.db.prepare("SELECT 1 FROM calculation_exceptions WHERE shift_id=? AND status='APPROVED' LIMIT 1").get(row.id);
  return calculateShift({
    clockIn: correction?.start_at ?? row.clock_in,
    clockOut: correction?.end_at ?? row.clock_out,
    hourlyWageYen: row.wage_snapshot,
    approvedActualMinutes: Boolean(exception),
    approvedLongShiftReview: Boolean(exception),
  });
}

function shiftRows(month?: string) {
  const sql = `SELECT s.*,e.name employee_name FROM work_shifts s JOIN employees e ON e.id=s.employee_id ${month ? 'WHERE substr(s.business_date,1,7)=?' : ''} ORDER BY s.created_at DESC`;
  return (month ? store.db.prepare(sql).all(month) : store.db.prepare(sql).all()) as any[];
}

function calculatedRows(month?: string) {
  return shiftRows(month).map((row) => ({ ...row, calculation: effectiveCalculation(row) }));
}

const csvCell = (value: unknown) => {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

function registerIpc() {
  readHandler('clock:home', () => ({
    adminConfigured: Boolean(store.db.prepare('SELECT 1 FROM administrators LIMIT 1').get()),
    requiresInitialPinChange: store.requiresInitialPinChange(),
    employees: store.db.prepare("SELECT e.*,w.hourly_wage FROM employees e JOIN wage_histories w ON w.employee_id=e.id WHERE e.status='ACTIVE' AND w.effective_at=(SELECT max(effective_at) FROM wage_histories WHERE employee_id=e.id) ORDER BY display_order").all(),
  }), false);
  readHandler('clock:status', (argument) => store.db.prepare('SELECT * FROM work_shifts WHERE employee_id=? ORDER BY created_at DESC LIMIT 1').get(z.string().uuid().parse(argument)), false);

  commandHandler('clock:in', employeeCommand, (value) => {
    const employee = store.db.prepare("SELECT e.*,w.hourly_wage FROM employees e JOIN wage_histories w ON w.employee_id=e.id WHERE e.id=? AND e.status='ACTIVE' ORDER BY w.effective_at DESC LIMIT 1").get(value.employeeId) as any;
    if (!employee) throw new Error('従業員が見つかりません');
    const now = Date.now();
    const shift = { id: randomUUID(), employee_id: employee.id, business_date: store.businessDate(now), clock_in: now, wage_snapshot: employee.hourly_wage, created_at: now };
    store.db.prepare('INSERT INTO work_shifts(id,employee_id,business_date,clock_in,wage_snapshot,created_at) VALUES(@id,@employee_id,@business_date,@clock_in,@wage_snapshot,@created_at)').run(shift);
    store.log('CLOCK_IN', employee.id, value.requestId);
    return shift;
  }, false, true);
  commandHandler('clock:out', employeeCommand, (value) => {
    const shift = store.db.prepare('SELECT * FROM work_shifts WHERE employee_id=? AND clock_out IS NULL').get(value.employeeId) as any;
    if (!shift) throw new Error('出勤中の勤務がありません');
    const clockOut = Date.now();
    if (clockOut <= shift.clock_in) throw new Error('PC時刻を確認してください。退勤は保存されていません。');
    const calculation = calculateShift({ clockIn: shift.clock_in, clockOut, hourlyWageYen: shift.wage_snapshot });
    store.db.prepare('UPDATE work_shifts SET clock_out=?,calc_status=? WHERE id=?').run(clockOut, calculation.status, shift.id);
    store.log('CLOCK_OUT', shift.id, value.requestId);
    return { ...shift, clock_out: clockOut, calc_status: calculation.status, calculation };
  }, false, true);

  commandHandler('auth:setup', baseCommand.extend({ pin: z.string().regex(/^\d{6}$/), displayName: z.string().min(1).max(80).optional() }), (value) => store.setup(value.pin, value.displayName), false, true);
  ipcMain.handle('auth:verify', async (event, argument) => {
    try {
      assertSender(event);
      const value = baseCommand.extend({ pin: z.string().regex(/^\d{6}$/) }).parse(argument);
      // Authentication responses can contain a one-time recovery code, so they
      // must not be persisted in command_receipts as ordinary command results are.
      return ok(store.verify(value.pin));
    } catch (error) {
      return { ok: false, code: 'OPERATION_FAILED', message: error instanceof Error ? error.message : 'PINを確認できませんでした。' };
    }
  });
  readHandler('auth:lock', () => { store.lock(); return null; }, false);
  ipcMain.handle('auth:change', async (event, argument) => {
    try {
      assertSender(event); store.requireAdmin();
      const value = baseCommand.extend({ oldPin: z.string().regex(/^\d{6}$/), newPin: z.string().regex(/^\d{6}$/) }).parse(argument);
      const result = await store.runAsyncCommand(value.requestId, 'auth:change', async () => { store.verify(value.oldPin); store.changePin(value.newPin); return { changed: true }; });
      if (result.ok) { try { await store.backup('AUTH_CHANGE'); } catch (error) { return { ...result, backupWarning: error instanceof Error ? error.message : 'バックアップに失敗しました。' }; } }
      return result;
    } catch (error) { return { ok: false, code: 'OPERATION_FAILED', message: error instanceof Error ? error.message : 'PINを変更できませんでした。' }; }
  });
  commandHandler('auth:recover', baseCommand.extend({ recoveryCode: z.string().min(10), newPin: z.string().regex(/^\d{6}$/) }), (value) => store.recover(value.recoveryCode, value.newPin), false, true);

  readHandler('employees:list', (argument) => store.db.prepare(`SELECT e.*, (SELECT hourly_wage FROM wage_histories w WHERE w.employee_id=e.id ORDER BY effective_at DESC LIMIT 1) hourly_wage FROM employees e ${argument ? '' : "WHERE status='ACTIVE'"} ORDER BY display_order`).all());
  commandHandler('employees:create', baseCommand.extend({ name: z.string().trim().min(1).max(80), hourlyWage: z.number().int().positive() }), (value) => {
    const employee = { id: randomUUID(), name: value.name, display_order: (store.db.prepare('SELECT COALESCE(MAX(display_order),0)+1 n FROM employees').get() as any).n };
    store.db.prepare("INSERT INTO employees(id,name,display_order,status) VALUES(@id,@name,@display_order,'ACTIVE')").run(employee);
    store.db.prepare('INSERT INTO wage_histories VALUES(?,?,?,?)').run(randomUUID(), employee.id, value.hourlyWage, Date.now());
    store.log('EMPLOYEE_CREATE', employee.id, value.requestId);
    return employee;
  }, true, true);
  commandHandler('employees:update', baseCommand.extend({ id: z.string().uuid(), name: z.string().trim().min(1).max(80).optional(), hourlyWage: z.number().int().positive().optional(), displayOrder: z.number().int().nonnegative().optional() }), (value) => {
    store.db.prepare('UPDATE employees SET name=COALESCE(?,name),display_order=COALESCE(?,display_order),version=version+1 WHERE id=?').run(value.name ?? null, value.displayOrder ?? null, value.id);
    if (value.hourlyWage) store.db.prepare('INSERT INTO wage_histories VALUES(?,?,?,?)').run(randomUUID(), value.id, value.hourlyWage, Date.now());
    store.log('EMPLOYEE_UPDATE', value.id, value.requestId);
    return { id: value.id };
  }, true, true);
  commandHandler('employees:archive', baseCommand.extend({ id: z.string().uuid() }), (value) => {
    const now = Date.now();
    store.db.prepare("UPDATE employees SET status='ARCHIVED',archived_at=?,restore_until=? WHERE id=?").run(now, now + 30 * 86_400_000, value.id);
    store.log('EMPLOYEE_ARCHIVE', value.id, value.requestId);
    return { id: value.id, status: 'ARCHIVED' };
  }, true, true);
  commandHandler('employees:restore', baseCommand.extend({ id: z.string().uuid() }), (value) => {
    const employee = store.db.prepare("SELECT * FROM employees WHERE id=? AND status='ARCHIVED'").get(value.id) as any;
    if (!employee || employee.restore_until < Date.now()) throw new Error('復元可能な30日間を過ぎています');
    store.db.prepare("UPDATE employees SET status='ACTIVE',archived_at=NULL,restore_until=NULL WHERE id=?").run(value.id);
    store.log('EMPLOYEE_RESTORE', value.id, value.requestId);
    return { id: value.id, status: 'ACTIVE' };
  }, true, true);
  commandHandler('employees:permanently-delete', baseCommand.extend({ id: z.string().uuid() }), (value) => {
    permanentlyDeleteEmployee(store.db, value.id);
    store.log('EMPLOYEE_PERMANENTLY_DELETE', value.id, value.requestId);
    return { id: value.id, deleted: true };
  }, true, true);

  readHandler('attendance:list', () => calculatedRows());
  readHandler('attendance:detail', (argument) => {
    const id = z.string().uuid().parse(argument);
    const row = shiftRows().find((item) => item.id === id);
    return row ? { ...row, calculation: effectiveCalculation(row) } : null;
  });
  commandHandler('attendance:propose', baseCommand.extend({ shiftId: z.string().uuid(), startAt: z.number().int(), endAt: z.number().int(), reason: z.string().trim().min(1) }), (value) => {
    if (value.endAt <= value.startAt) throw new Error('退勤は出勤より後にしてください');
    const id = randomUUID();
    store.db.prepare('INSERT INTO attendance_corrections VALUES(?,?,?,?,?,?,?)').run(id, value.shiftId, value.startAt, value.endAt, value.reason, 'PENDING', Date.now());
    store.log('CORRECTION_PROPOSE', value.shiftId, value.requestId);
    return { id };
  }, true, true);
  commandHandler('attendance:decide', baseCommand.extend({ id: z.string().uuid(), approve: z.boolean(), reason: z.string().trim().min(1) }), (value) => {
    const status = value.approve ? 'APPROVED' : 'REJECTED';
    store.db.prepare('UPDATE attendance_corrections SET status=? WHERE id=?').run(status, value.id);
    store.db.prepare('INSERT INTO correction_approvals VALUES(?,?,?,?,?)').run(randomUUID(), value.id, status, value.reason, Date.now());
    const correction = store.db.prepare('SELECT shift_id FROM attendance_corrections WHERE id=?').get(value.id) as any;
    if (correction) {
      const shift = shiftRows().find((item) => item.id === correction.shift_id);
      const calculation = shift ? effectiveCalculation(shift) : null;
      if (calculation) store.db.prepare('UPDATE work_shifts SET calc_status=? WHERE id=?').run(calculation.status, correction.shift_id);
    }
    store.log('CORRECTION_DECIDE', value.id, value.requestId);
    return { id: value.id, status };
  }, true, true);
  commandHandler('attendance:exception', baseCommand.extend({ shiftId: z.string().uuid(), reason: z.string().trim().min(1) }), (value) => {
    const shift = store.db.prepare('SELECT * FROM work_shifts WHERE id=? AND clock_out IS NOT NULL').get(value.shiftId) as any;
    if (!shift) throw new Error('完了した勤務が見つかりません');
    const preview = calculateShift({ clockIn: shift.clock_in, clockOut: shift.clock_out, hourlyWageYen: shift.wage_snapshot });
    if (preview.status !== 'NEEDS_REVIEW') throw new Error('例外承認が必要な勤務ではありません');
    store.db.prepare('INSERT INTO calculation_exceptions VALUES(?,?,?,?,?)').run(randomUUID(), value.shiftId, value.reason, 'APPROVED', Date.now());
    store.db.prepare("UPDATE work_shifts SET calc_status='CALCULATED' WHERE id=?").run(value.shiftId);
    store.log('CALCULATION_EXCEPTION', value.shiftId, value.requestId);
    return { approved: true };
  }, true, true);

  readHandler('monthly:list', () => store.db.prepare("SELECT substr(business_date,1,7) month,COUNT(*) shifts,SUM(clock_out IS NULL) openShifts,SUM(CASE WHEN calc_status='NEEDS_REVIEW' THEN 1 ELSE 0 END) reviewShifts FROM work_shifts GROUP BY month ORDER BY month DESC").all());
  readHandler('monthly:detail', (argument) => {
    const month = z.string().regex(/^\d{4}-\d{2}$/).parse(argument);
    const rows = calculatedRows(month);
    const employees = new Map<string, { id: string; name: string }>();
    const shifts: MonthlyShift[] = [];
    for (const row of rows) {
      employees.set(row.employee_id, { id: row.employee_id, name: row.employee_name });
      if (row.calculation) shifts.push({ employeeId: row.employee_id, ...row.calculation });
    }
    return [...employees.values()].map((employee) => ({ name: employee.name, ...summarizeEmployeeMonth(employee.id, month, shifts) }));
  });
  readHandler('monthly:csv', async (argument) => {
    const month = z.string().regex(/^\d{4}-\d{2}$/).parse(argument);
    const header = ['氏名','勤務日','元出勤','元退勤','丸め出勤','丸め退勤','計算方式','通常分','深夜分','時給','1/240円単位','状態'];
    const lines = calculatedRows(month).map((row) => {
      const calculation = row.calculation;
      return [row.employee_name,row.business_date,row.clock_in,row.clock_out,calculation?.roundedClockInMs,calculation?.roundedClockOutMs,calculation?.calculationMethod,calculation?.regularMinutes,calculation?.nightMinutes,row.wage_snapshot,calculation?.pay240thYen,calculation?.status].map(csvCell).join(',');
    });
    lines.push(csvCell('注意: 残業・休日・控除等を含まない30分丸めの参考値です。'));
    const csv = `\uFEFF${header.map(csvCell).join(',')}\r\n${lines.join('\r\n')}`;
    const selected = await dialog.showSaveDialog(mainWindow!, { defaultPath: `給与見込み-${month}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (!selected.canceled && selected.filePath) fs.writeFileSync(selected.filePath, csv, 'utf8');
    return { canceled: selected.canceled, filePath: selected.filePath };
  });
  readHandler('monthly:print', () => { mainWindow?.webContents.print({ silent: false, printBackground: true }); return null; });
  readHandler('monthly:close', () => { throw new Error('月締めはバックアップ連携完了後に利用できます'); });
  readHandler('monthly:reopen', () => { throw new Error('月締め解除はバックアップ連携完了後に利用できます'); });

  readHandler('operations:dashboard', () => ({
    employees: store.db.prepare("SELECT count(*) n FROM employees WHERE status='ACTIVE'").get(),
    openShifts: store.db.prepare('SELECT count(*) n FROM work_shifts WHERE clock_out IS NULL').get(),
    reviewShifts: store.db.prepare("SELECT count(*) n FROM work_shifts WHERE calc_status='NEEDS_REVIEW'").get(),
    latestBackup: store.db.prepare('SELECT * FROM backup_histories ORDER BY created_at DESC LIMIT 1').get(),
  }));
  readHandler('operations:logs', () => store.db.prepare('SELECT * FROM operation_logs ORDER BY created_at DESC LIMIT 200').all());
  readHandler('settings:get', () => store.db.prepare('SELECT key,value FROM app_settings').all());
  commandHandler('settings:update', baseCommand.passthrough(), (value) => {
    const entries = Object.entries(value).filter(([key]) => key !== 'requestId');
    const statement = store.db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    for (const [key, settingValue] of entries) statement.run(key, JSON.stringify(settingValue));
    return { updated: entries.map(([key]) => key) };
  }, true, true);
  readHandler('settings:testSound', () => ({ played: false }));

  readHandler('backup:list', () => store.db.prepare('SELECT * FROM backup_histories ORDER BY created_at DESC').all());
  ipcMain.handle('backup:create', async (event, argument) => {
    try {
      assertSender(event);
      store.requireAdmin();
      const value = baseCommand.extend({ kind: z.string().max(40).optional() }).parse(argument);
      return await store.runAsyncCommand(value.requestId, 'backup:create', () => store.backup(value.kind ?? 'MANUAL'));
    } catch (error) {
      return { ok: false, code: 'OPERATION_FAILED', message: error instanceof Error ? error.message : 'バックアップに失敗しました。' };
    }
  });
  readHandler('backup:verify', (argument) => {
    const id = z.string().uuid().parse(argument);
    const backup = store.db.prepare('SELECT * FROM backup_histories WHERE id=?').get(id) as any;
    if (!backup) throw new Error('バックアップがありません');
    const bytes = fs.readFileSync(store.backupPath(backup.file_name));
    return { valid: createHash('sha256').update(bytes).digest('hex') === backup.sha256 };
  });
  readHandler('backup:restore', () => { throw new Error('復元は安全な再起動フロー未実装のため利用できません'); });

  readHandler('app:version', () => app.getVersion(), false);
  readHandler('app:quit', () => { store.requireRecentAuth(); app.quit(); return null; });
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else {
  app.whenReady().then(async () => {
    try {
      store = new Store();
      registerIpc();
      mainWindow = new BrowserWindow({
        fullscreen: true,
        show: false,
        webPreferences: {
          preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          devTools: !app.isPackaged,
        },
      });
      mainWindow.removeMenu();
      mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
      mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"] } }));
      await mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
      mainWindow.show();
      mainWindow.focus();
    } catch (error) {
      const message = error instanceof Error ? error.message : '不明な起動エラーです。';
      dialog.showErrorBox('アプリを起動できませんでした', message);
      app.quit();
    }
  });
  app.on('second-instance', () => { mainWindow?.restore(); mainWindow?.focus(); });
  app.on('window-all-closed', () => app.quit());
}

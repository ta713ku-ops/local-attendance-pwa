import Database from 'better-sqlite3';
import { app } from 'electron';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';

export type AppResult<T> =
  | { ok: true; data: T; backupWarning?: string }
  | { ok: false; code: string; message: string; needsAuth?: boolean };

export class Store {
  readonly db: Database.Database;
  private readonly dataDirectory: string;
  private adminUntil = 0;
  private recentAuthUntil = 0;
  private backupQueue: Promise<unknown> = Promise.resolve();

  constructor() {
    this.dataDirectory = path.join(app.getPath('userData'), 'data');
    fs.mkdirSync(this.dataDirectory, { recursive: true });
    this.db = new Database(path.join(this.dataDirectory, 'attendance.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = FULL');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS administrators(id TEXT PRIMARY KEY, display_name TEXT NOT NULL, pin_hash TEXT NOT NULL, recovery_hash TEXT NOT NULL, failed_count INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS employees(id TEXT PRIMARY KEY, name TEXT NOT NULL, display_order INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('ACTIVE','ARCHIVED')), archived_at INTEGER, restore_until INTEGER, version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS wage_histories(id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id), hourly_wage INTEGER NOT NULL CHECK(hourly_wage > 0), effective_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS work_shifts(id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id), business_date TEXT NOT NULL, clock_in INTEGER NOT NULL, clock_out INTEGER, wage_snapshot INTEGER NOT NULL, calc_status TEXT NOT NULL DEFAULT 'OPEN', created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_shift ON work_shifts(employee_id) WHERE clock_out IS NULL;
      CREATE TABLE IF NOT EXISTS attendance_corrections(id TEXT PRIMARY KEY, shift_id TEXT NOT NULL REFERENCES work_shifts(id), start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_pending_correction ON attendance_corrections(shift_id) WHERE status='PENDING';
      CREATE TABLE IF NOT EXISTS correction_approvals(id TEXT PRIMARY KEY, correction_id TEXT NOT NULL REFERENCES attendance_corrections(id), decision TEXT NOT NULL CHECK(decision IN ('APPROVED','REJECTED')), reason TEXT NOT NULL, decided_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS calculation_exceptions(id TEXT PRIMARY KEY, shift_id TEXT NOT NULL REFERENCES work_shifts(id), reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', approved_at INTEGER);
      CREATE TABLE IF NOT EXISTS monthly_periods(month TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'OPEN', closed_at INTEGER);
      CREATE TABLE IF NOT EXISTS monthly_closings(id TEXT PRIMARY KEY, month TEXT NOT NULL REFERENCES monthly_periods(month), action TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS monthly_employee_summaries(id TEXT PRIMARY KEY, month TEXT NOT NULL, employee_id TEXT NOT NULL REFERENCES employees(id), minutes INTEGER NOT NULL, estimated_yen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS app_sessions(id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER, app_version TEXT);
      CREATE TABLE IF NOT EXISTS operation_logs(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, kind TEXT NOT NULL, target_id TEXT, request_id TEXT, result TEXT NOT NULL, before_json TEXT, after_json TEXT);
      CREATE TABLE IF NOT EXISTS command_receipts(request_id TEXT PRIMARY KEY, kind TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS backup_histories(id TEXT PRIMARY KEY, file_name TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, size INTEGER, sha256 TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS no_original_clock_update BEFORE UPDATE OF clock_in ON work_shifts BEGIN SELECT RAISE(ABORT, '元打刻は変更できません'); END;
      CREATE TRIGGER IF NOT EXISTS no_closed_shift_update BEFORE UPDATE ON work_shifts WHEN EXISTS(SELECT 1 FROM monthly_periods p WHERE p.month=substr(OLD.business_date,1,7) AND p.status='CLOSED') BEGIN SELECT RAISE(ABORT, '月締め済みです'); END;
      CREATE TRIGGER IF NOT EXISTS no_closed_correction_insert BEFORE INSERT ON attendance_corrections WHEN EXISTS(SELECT 1 FROM work_shifts s JOIN monthly_periods p ON p.month=substr(s.business_date,1,7) WHERE s.id=NEW.shift_id AND p.status='CLOSED') BEGIN SELECT RAISE(ABORT, '月締め済みです'); END;
    `);
    this.db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES(?, ?)').run(2, Date.now());
    const setting = this.db.prepare('INSERT OR IGNORE INTO app_settings(key,value) VALUES(?,?)');
    setting.run('homeTimeoutSeconds', '30');
    setting.run('adminLockMinutes', '5');
    setting.run('backupGenerations', '500');
    setting.run('soundEnabled', 'true');
    this.ensureInitialAdministrator();
  }

  private ensureInitialAdministrator() {
    const administratorExists = Boolean(this.db.prepare('SELECT 1 FROM administrators LIMIT 1').get());
    if (administratorExists) {
      this.db.prepare("INSERT OR IGNORE INTO app_settings(key,value) VALUES('requiresInitialPinChange','false')").run();
      this.db.prepare("INSERT OR IGNORE INTO app_settings(key,value) VALUES('initialRecoveryPending','false')").run();
      return;
    }

    this.db.transaction(() => {
      // The bootstrap recovery value is deliberately discarded. A usable recovery
      // code is generated only after the first successful administrator login.
      const discardedRecovery = randomBytes(20).toString('base64url');
      this.db.prepare('INSERT INTO administrators VALUES(?,?,?,?,0,0,1)').run(
        randomUUID(),
        '管理者',
        this.hash('123456'),
        this.hash(discardedRecovery),
      );
      this.setSetting('requiresInitialPinChange', 'true');
      this.setSetting('initialRecoveryPending', 'true');
    })();
  }

  private setSetting(key: string, value: string) {
    this.db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }

  requiresInitialPinChange() {
    return (this.db.prepare("SELECT value FROM app_settings WHERE key='requiresInitialPinChange'").get() as { value?: string } | undefined)?.value === 'true';
  }

  private hash(value: string, salt = randomBytes(16).toString('hex')) {
    return `${salt}:${scryptSync(value, salt, 64).toString('hex')}`;
  }

  private check(value: string, stored: string) {
    const [salt, digest] = stored.split(':');
    if (!salt || !digest) return false;
    const actual = scryptSync(value, salt, 64);
    const expected = Buffer.from(digest, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  runCommand<T>(requestId: string, kind: string, operation: () => T): AppResult<T> & { replayed?: boolean } {
    const previous = this.db.prepare('SELECT kind,result_json FROM command_receipts WHERE request_id=?').get(requestId) as { kind: string; result_json: string } | undefined;
    if (previous) {
      if (previous.kind !== kind) return { ok: false, code: 'REQUEST_ID_REUSED', message: 'requestId は別の操作に再利用できません。' };
      return { ...(JSON.parse(previous.result_json) as AppResult<T>), replayed: true };
    }
    try {
      return this.db.transaction(() => {
        const result: AppResult<T> = { ok: true, data: operation() };
        this.db.prepare('INSERT INTO command_receipts VALUES(?,?,?,?)').run(requestId, kind, JSON.stringify(result), Date.now());
        return result;
      })();
    } catch (error) {
      return { ok: false, code: 'OPERATION_FAILED', message: error instanceof Error ? error.message : '操作に失敗しました。' };
    }
  }

  async runAsyncCommand<T>(requestId: string, kind: string, operation: () => Promise<T>): Promise<AppResult<T>> {
    const previous = this.db.prepare('SELECT kind,result_json FROM command_receipts WHERE request_id=?').get(requestId) as { kind: string; result_json: string } | undefined;
    if (previous) {
      if (previous.kind !== kind) return { ok: false, code: 'REQUEST_ID_REUSED', message: 'requestId は別の操作に再利用できません。' };
      return JSON.parse(previous.result_json) as AppResult<T>;
    }
    try {
      const result: AppResult<T> = { ok: true, data: await operation() };
      this.db.prepare('INSERT INTO command_receipts VALUES(?,?,?,?)').run(requestId, kind, JSON.stringify(result), Date.now());
      return result;
    } catch (error) {
      return { ok: false, code: 'OPERATION_FAILED', message: error instanceof Error ? error.message : '操作に失敗しました。' };
    }
  }

  setup(pin: string, displayName = '管理者') {
    if (this.db.prepare('SELECT 1 FROM administrators').get()) throw new Error('初期設定済みです');
    this.validatePin(pin);
    const recoveryCode = randomBytes(20).toString('base64url');
    this.db.prepare('INSERT INTO administrators VALUES(?,?,?,?,0,0,1)').run(randomUUID(), displayName, this.hash(pin), this.hash(recoveryCode));
    this.setSetting('requiresInitialPinChange', 'false');
    this.setSetting('initialRecoveryPending', 'false');
    this.refreshAuthentication();
    return { recoveryCode };
  }

  verify(pin: string) {
    const administrator = this.db.prepare('SELECT * FROM administrators LIMIT 1').get() as any;
    if (!administrator) throw new Error('初期設定が必要です');
    if (administrator.locked_until > Date.now()) throw new Error('PINは一時ロック中です');
    if (!this.check(pin, administrator.pin_hash)) {
      const failures = administrator.failed_count + 1;
      const wait = failures >= 5 ? Math.min(900_000, 30_000 * 2 ** (failures - 5)) : 0;
      this.db.prepare('UPDATE administrators SET failed_count=?,locked_until=? WHERE id=?').run(failures, Date.now() + wait, administrator.id);
      throw new Error('PINが正しくありません');
    }
    let recoveryCode: string | undefined;
    this.db.transaction(() => {
      this.db.prepare('UPDATE administrators SET failed_count=0,locked_until=0 WHERE id=?').run(administrator.id);
      const pending = (this.db.prepare("SELECT value FROM app_settings WHERE key='initialRecoveryPending'").get() as { value?: string } | undefined)?.value === 'true';
      if (pending) {
        recoveryCode = randomBytes(20).toString('base64url');
        this.db.prepare('UPDATE administrators SET recovery_hash=?,version=version+1 WHERE id=?').run(this.hash(recoveryCode), administrator.id);
        this.setSetting('initialRecoveryPending', 'false');
      }
    })();
    this.refreshAuthentication();
    return { authenticatedUntil: this.adminUntil, requiresInitialPinChange: this.requiresInitialPinChange(), ...(recoveryCode ? { recoveryCode } : {}) };
  }

  changePin(pin: string) {
    this.validatePin(pin);
    this.db.prepare('UPDATE administrators SET pin_hash=?,version=version+1').run(this.hash(pin));
    this.setSetting('requiresInitialPinChange', 'false');
    this.refreshAuthentication();
  }

  recover(code: string, pin: string) {
    this.validatePin(pin);
    const administrator = this.db.prepare('SELECT * FROM administrators LIMIT 1').get() as any;
    if (!administrator || !this.check(code, administrator.recovery_hash)) throw new Error('回復コードが正しくありません');
    const recoveryCode = randomBytes(20).toString('base64url');
    this.db.prepare('UPDATE administrators SET pin_hash=?,recovery_hash=?,failed_count=0,locked_until=0 WHERE id=?').run(this.hash(pin), this.hash(recoveryCode), administrator.id);
    this.setSetting('requiresInitialPinChange', 'false');
    this.setSetting('initialRecoveryPending', 'false');
    this.refreshAuthentication();
    return { recoveryCode };
  }

  private validatePin(pin: string) {
    if (!/^\d{6}$/.test(pin)) throw new Error('PINは6桁の数字です');
  }

  private refreshAuthentication() {
    this.adminUntil = Date.now() + 5 * 60_000;
    this.recentAuthUntil = Date.now() + 2 * 60_000;
  }

  lock() { this.adminUntil = 0; this.recentAuthUntil = 0; }
  requireAdmin() { if (Date.now() > this.adminUntil) throw new Error('再認証が必要です'); }
  requireRecentAuth() { if (Date.now() > this.recentAuthUntil) throw new Error('直近のPIN認証が必要です'); }

  businessDate(timestamp = Date.now()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(timestamp);
  }

  log(kind: string, target: string | undefined, requestId: string, result = 'SUCCESS') {
    this.db.prepare('INSERT INTO operation_logs VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), Date.now(), kind, target ?? null, requestId, result, null, null);
  }

  backup(kind = 'MANUAL') {
    const task = this.backupQueue.then(() => this.createBackup(kind));
    this.backupQueue = task.catch(() => undefined);
    return task;
  }

  private async createBackup(kind: string) {
    const directory = path.join(this.dataDirectory, 'backups');
    fs.mkdirSync(directory, { recursive: true });
    const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${kind}-${randomUUID()}.sqlite`;
    const temporary = path.join(directory, `.${fileName}.tmp`);
    const destination = path.join(directory, fileName);
    const id = randomUUID();
    try {
      await this.db.backup(temporary);
      const validation = new Database(temporary, { readonly: true });
      const quickCheck = validation.pragma('quick_check', { simple: true });
      validation.close();
      if (quickCheck !== 'ok') throw new Error('バックアップ整合性検証に失敗しました');
      const bytes = fs.readFileSync(temporary);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      fs.renameSync(temporary, destination);
      try {
        this.db.prepare('INSERT INTO backup_histories VALUES(?,?,?,?,?,?,?)').run(id, fileName, kind, 'SUCCESS', bytes.length, sha256, Date.now());
      } catch (error) {
        fs.rmSync(destination, { force: true });
        throw error;
      }
      this.rotateAutomaticBackups(directory);
      return { id, fileName, sha256 };
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      try { this.db.prepare('INSERT INTO backup_histories VALUES(?,?,?,?,?,?,?)').run(id, fileName, kind, 'FAILED', null, null, Date.now()); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  private rotateAutomaticBackups(directory: string) {
    const configured = Number((this.db.prepare("SELECT value FROM app_settings WHERE key='backupGenerations'").get() as any)?.value ?? 500);
    const limit = Math.max(50, Number.isFinite(configured) ? Math.floor(configured) : 500);
    const protectedKinds = ['MANUAL', 'MONTH_CLOSE', 'MONTH_REOPEN', 'PRE_RESTORE'];
    const old = this.db.prepare(`SELECT id,file_name FROM backup_histories WHERE status='SUCCESS' AND kind NOT IN (${protectedKinds.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT -1 OFFSET ?`).all(...protectedKinds, limit) as Array<{ id: string; file_name: string }>;
    const remove = this.db.prepare('DELETE FROM backup_histories WHERE id=?');
    for (const backup of old) {
      fs.rmSync(path.join(directory, path.basename(backup.file_name)), { force: true });
      remove.run(backup.id);
    }
  }

  backupPath(fileName: string) {
    return path.join(this.dataDirectory, 'backups', path.basename(fileName));
  }
}

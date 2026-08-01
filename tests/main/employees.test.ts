import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { permanentlyDeleteEmployee } from '../../src/main/employees';

describe('permanentlyDeleteEmployee', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE employees(id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE wage_histories(id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id));
      CREATE TABLE work_shifts(id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id));
      CREATE TABLE attendance_corrections(id TEXT PRIMARY KEY, shift_id TEXT NOT NULL REFERENCES work_shifts(id));
      CREATE TABLE correction_approvals(id TEXT PRIMARY KEY, correction_id TEXT NOT NULL REFERENCES attendance_corrections(id));
      CREATE TABLE calculation_exceptions(id TEXT PRIMARY KEY, shift_id TEXT NOT NULL REFERENCES work_shifts(id));
      CREATE TABLE monthly_employee_summaries(id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id));
    `);
  });

  afterEach(() => db.close());

  it('deletes an archived employee and all dependent records', () => {
    db.prepare("INSERT INTO employees VALUES('archived','ARCHIVED'),('active','ACTIVE')").run();
    db.prepare("INSERT INTO wage_histories VALUES('w-archived','archived'),('w-active','active')").run();
    db.prepare("INSERT INTO work_shifts VALUES('s-archived','archived'),('s-active','active')").run();
    db.prepare("INSERT INTO attendance_corrections VALUES('c-archived','s-archived'),('c-active','s-active')").run();
    db.prepare("INSERT INTO correction_approvals VALUES('a-archived','c-archived'),('a-active','c-active')").run();
    db.prepare("INSERT INTO calculation_exceptions VALUES('e-archived','s-archived'),('e-active','s-active')").run();
    db.prepare("INSERT INTO monthly_employee_summaries VALUES('m-archived','archived'),('m-active','active')").run();

    db.transaction(() => permanentlyDeleteEmployee(db, 'archived'))();

    for (const table of ['employees', 'wage_histories', 'work_shifts', 'attendance_corrections', 'correction_approvals', 'calculation_exceptions', 'monthly_employee_summaries']) {
      expect((db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count).toBe(1);
    }
    expect(db.prepare("SELECT 1 FROM employees WHERE id='archived'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM employees WHERE id='active'").get()).toBeDefined();
  });

  it('refuses to permanently delete an active employee', () => {
    db.prepare("INSERT INTO employees VALUES('active','ACTIVE')").run();

    expect(() => permanentlyDeleteEmployee(db, 'active')).toThrow('完全に削除できるのは削除済みの従業員だけです');
  });
});

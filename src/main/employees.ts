import Database from 'better-sqlite3';

export function permanentlyDeleteEmployee(db: Database.Database, employeeId: string) {
  const employee = db.prepare('SELECT id,status FROM employees WHERE id=?').get(employeeId) as { id: string; status: string } | undefined;
  if (!employee) throw new Error('従業員が見つかりません');
  if (employee.status !== 'ARCHIVED') throw new Error('完全に削除できるのは削除済みの従業員だけです');

  const shiftIds = 'SELECT id FROM work_shifts WHERE employee_id=?';
  const correctionIds = `SELECT id FROM attendance_corrections WHERE shift_id IN (${shiftIds})`;
  db.prepare(`DELETE FROM correction_approvals WHERE correction_id IN (${correctionIds})`).run(employeeId);
  db.prepare(`DELETE FROM attendance_corrections WHERE shift_id IN (${shiftIds})`).run(employeeId);
  db.prepare(`DELETE FROM calculation_exceptions WHERE shift_id IN (${shiftIds})`).run(employeeId);
  db.prepare('DELETE FROM monthly_employee_summaries WHERE employee_id=?').run(employeeId);
  db.prepare('DELETE FROM work_shifts WHERE employee_id=?').run(employeeId);
  db.prepare('DELETE FROM wage_histories WHERE employee_id=?').run(employeeId);
  db.prepare("DELETE FROM employees WHERE id=? AND status='ARCHIVED'").run(employeeId);
}

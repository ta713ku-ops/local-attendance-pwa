import { describe, expect, it } from 'vitest';
import { allocateEmployeeMonthPay, calculateNightMinutes, calculateShift, decideClockAction, formatJstDate, getAttendanceStatus, roundClockInUp, roundClockOutDown, summarizeEmployeeMonth, type PayAllocationShift } from '../../src/domain';

const at = (value: string) => new Date(value).getTime();

describe('JST rounding and calendar ownership', () => {
  it('rounds clock-in up and clock-out down at 30-minute boundaries', () => {
    expect(new Date(roundClockInUp(at('2024-01-01T00:00:01+09:00'))).toISOString()).toBe('2023-12-31T15:30:00.000Z');
    expect(new Date(roundClockOutDown(at('2024-01-01T00:29:59+09:00'))).toISOString()).toBe('2023-12-31T15:00:00.000Z');
    expect(roundClockInUp(at('2024-01-01T00:30:00+09:00'))).toBe(at('2024-01-01T00:30:00+09:00'));
  });

  it('uses JST for dates independent of the machine time zone, including new year and leap day', () => {
    expect(formatJstDate('2023-12-31T15:30:00.000Z')).toBe('2024-01-01');
    expect(formatJstDate('2024-02-29T14:59:00.000Z')).toBe('2024-02-29');
    expect(formatJstDate('2024-02-29T15:00:00.000Z')).toBe('2024-03-01');
  });

  it('assigns all a cross-month shift to its JST clock-in month', () => {
    const result = calculateShift({ clockIn: '2024-01-31T23:00:00+09:00', clockOut: '2024-02-01T07:00:00+09:00', hourlyWageYen: 1200 });
    expect(result).toMatchObject({ status: 'CALCULATED', workDateJst: '2024-01-31', monthJst: '2024-01', totalMinutes: 480, nightMinutes: 360 });
  });
});

describe('calculation and night work', () => {
  it('flags non-positive rounded shifts until the actual-minute exception is approved', () => {
    const normal = calculateShift({ clockIn: '2024-06-01T09:01:00+09:00', clockOut: '2024-06-01T09:29:00+09:00', hourlyWageYen: 1000 });
    expect(normal).toMatchObject({ status: 'NEEDS_REVIEW', reviewReason: 'NON_POSITIVE_ROUNDED_DURATION' });
    const approved = calculateShift({ clockIn: '2024-06-01T09:01:00+09:00', clockOut: '2024-06-01T09:29:00+09:00', hourlyWageYen: 1000, approvedActualMinutes: true });
    expect(approved).toMatchObject({ status: 'CALCULATED', calculationMethod: 'APPROVED_ACTUAL_MINUTES', totalMinutes: 28 });
  });

  it('splits night work across midnight and exact 22:00/05:00 boundaries', () => {
    expect(calculateNightMinutes('2024-02-28T21:30:00+09:00', '2024-02-29T05:30:00+09:00')).toBe(420);
    expect(calculateNightMinutes('2024-12-31T22:00:00+09:00', '2025-01-01T05:00:00+09:00')).toBe(420);
  });

  it('holds pay in 1/240 yen units and only rounds the employee month total', () => {
    const a = calculateShift({ clockIn: '2024-01-01T09:00:00+09:00', clockOut: '2024-01-01T09:01:00+09:00', hourlyWageYen: 1001, approvedActualMinutes: true });
    const b = calculateShift({ clockIn: '2024-01-02T09:00:00+09:00', clockOut: '2024-01-02T09:01:00+09:00', hourlyWageYen: 1001, approvedActualMinutes: true });
    const summary = summarizeEmployeeMonth('e1', '2024-01', [{ employeeId: 'e1', ...a }, { employeeId: 'e1', ...b }]);
    expect(a.pay240thYen).toBe(4004);
    expect(a).toMatchObject({ regularPay240thYen: 4004, nightPay240thYen: 0 });
    expect(summary).toMatchObject({ totalMinutes: 2, pay240thYen: 8008, roundedYen: 33 });
  });

  it('keeps regular and night pay exact across a night boundary', () => {
    const result = calculateShift({ clockIn: '2024-01-01T21:30:00+09:00', clockOut: '2024-01-02T05:30:00+09:00', hourlyWageYen: 1001 });
    expect(result).toMatchObject({ regularMinutes: 60, nightMinutes: 420, regularPay240thYen: 240240, nightPay240thYen: 2102100, pay240thYen: 2342340 });
  });

  it('keeps a 1177 yen half-hour exact and accepts an independent 1471 yen night rate', () => {
    const regular = calculateShift({ clockIn: '2024-01-01T09:00:00+09:00', clockOut: '2024-01-01T09:30:00+09:00', hourlyWageYen: 1177, nightHourlyWageYen: 1471 });
    expect(regular).toMatchObject({ regularMinutes: 30, nightMinutes: 0, regularPay240thYen: 141240, pay240thYen: 141240 });
    expect(regular.pay240thYen / 240).toBe(588.5);

    const boundary = calculateShift({ clockIn: '2024-01-01T21:30:00+09:00', clockOut: '2024-01-01T22:30:00+09:00', hourlyWageYen: 1177, nightHourlyWageYen: 1471 });
    expect(boundary).toMatchObject({ regularMinutes: 30, nightMinutes: 30, regularPay240thYen: 141240, nightPay240thYen: 176520, pay240thYen: 317760 });
    expect(boundary.regularPay240thYen / 240).toBe(588.5);
    expect(boundary.nightPay240thYen / 240).toBe(735.5);
    expect(boundary.pay240thYen / 240).toBe(1324);
  });

  it('keeps the historical 25 percent night premium when no independent night rate exists', () => {
    const legacy = calculateShift({ clockIn: '2024-01-01T21:30:00+09:00', clockOut: '2024-01-01T22:30:00+09:00', hourlyWageYen: 1177 });
    expect(legacy).toMatchObject({ regularPay240thYen: 141240, nightPay240thYen: 176550, pay240thYen: 317790 });
    expect(legacy.nightPay240thYen / 240).toBe(735.625);
  });

  it('requires review from the source timestamps when a 24-hour-plus shift rounds below 24 hours', () => {
    const exactly24Hours = calculateShift({ clockIn: '2024-02-28T00:01:00+09:00', clockOut: '2024-02-29T00:01:00+09:00', hourlyWageYen: 1000 });
    expect(exactly24Hours.status).toBe('CALCULATED');
    const review = calculateShift({ clockIn: '2024-02-28T00:01:00+09:00', clockOut: '2024-02-29T00:02:00+09:00', hourlyWageYen: 1000 });
    expect(review).toMatchObject({ status: 'NEEDS_REVIEW', reviewReason: 'OVER_24_HOURS' });
    // The rounded interval is only 23.5 hours, but management approval permits it.
    expect(calculateShift({ clockIn: '2024-02-28T00:01:00+09:00', clockOut: '2024-02-29T00:02:00+09:00', hourlyWageYen: 1000, approvedLongShiftReview: true }).status).toBe('CALCULATED');
  });
});

describe('employee-month pay allocation', () => {
  const shift = (overrides: Partial<PayAllocationShift> & Pick<PayAllocationShift, 'shiftId' | 'effectiveClockIn'>): PayAllocationShift => ({
    employeeId: 'e1', status: 'CALCULATED', regularPay240thYen: 0, nightPay240thYen: 0, ...overrides,
  });

  it('uses effective clock-in month and excludes working, review, and other employees', () => {
    const result = allocateEmployeeMonthPay('e1', '2024-01', [
      shift({ shiftId: 'cross-month', effectiveClockIn: '2024-01-31T23:50:00+09:00', regularPay240thYen: 240 }),
      shift({ shiftId: 'working', effectiveClockIn: '2024-01-02T09:00:00+09:00', status: 'WORKING', regularPay240thYen: 24000 }),
      shift({ shiftId: 'review', effectiveClockIn: '2024-01-02T09:00:00+09:00', status: 'NEEDS_REVIEW', regularPay240thYen: 24000 }),
      shift({ shiftId: 'other', effectiveClockIn: '2024-01-02T09:00:00+09:00', employeeId: 'e2', regularPay240thYen: 24000 }),
    ]);
    expect(result).toMatchObject({ exact240thYen: 240, roundedYen: 1 });
    expect(result.shifts.map((item) => item.shiftId)).toEqual(['cross-month']);
  });

  it('allocates by remainder, then date, clock-in, shift id, and regular before night', () => {
    const result = allocateEmployeeMonthPay('e1', '2024-01', [
      shift({ shiftId: 'later-date', effectiveClockIn: '2024-01-03T08:00:00+09:00', regularPay240thYen: 121 }),
      shift({ shiftId: 'b', effectiveClockIn: '2024-01-02T09:00:00+09:00', regularPay240thYen: 121 }),
      shift({ shiftId: 'a', effectiveClockIn: '2024-01-02T09:00:00+09:00', regularPay240thYen: 121, nightPay240thYen: 121 }),
      shift({ shiftId: 'earlier-clock', effectiveClockIn: '2024-01-02T08:00:00+09:00', regularPay240thYen: 121 }),
      shift({ shiftId: 'large-remainder', effectiveClockIn: '2024-01-04T08:00:00+09:00', regularPay240thYen: 239 }),
    ]);
    expect(result.roundedYen).toBe(4);
    const amounts = Object.fromEntries(result.shifts.map((item) => [item.shiftId, [item.regular.allocatedYen, item.night.allocatedYen]]));
    expect(amounts).toEqual({ 'earlier-clock': [1, 0], a: [1, 1], b: [0, 0], 'later-date': [0, 0], 'large-remainder': [1, 0] });
    expect(result.shifts.flatMap((item) => [item.regular.allocatedYen, item.night.allocatedYen]).reduce((a, b) => a + b, 0)).toBe(result.roundedYen);

    const componentTie = allocateEmployeeMonthPay('e1', '2024-01', [
      shift({ shiftId: 'same-shift', effectiveClockIn: '2024-01-01T09:00:00+09:00', regularPay240thYen: 120, nightPay240thYen: 120 }),
    ]);
    expect(componentTie.shifts[0]).toMatchObject({ regular: { allocatedYen: 1 }, night: { allocatedYen: 0 } });
  });

  it('handles same-day multiple short shifts and amounts containing whole yen', () => {
    const result = allocateEmployeeMonthPay('e1', '2024-01', [
      shift({ shiftId: 'short-1', effectiveClockIn: '2024-01-10T09:00:00+09:00', regularPay240thYen: 4004 }),
      shift({ shiftId: 'short-2', effectiveClockIn: '2024-01-10T10:00:00+09:00', regularPay240thYen: 4004 }),
      shift({ shiftId: 'whole', effectiveClockIn: '2024-01-10T11:00:00+09:00', nightPay240thYen: 240 }),
    ]);
    expect(result).toMatchObject({ exact240thYen: 8248, roundedYen: 34 });
    expect(result.shifts.reduce((sum, item) => sum + item.allocatedYen, 0)).toBe(34);
  });
});

describe('clock state machine', () => {
  it('rejects checkout without an open shift and duplicate check-in', () => {
    const noOpen = { shifts: [], now: '2024-01-01T09:00:00+09:00' };
    expect(decideClockAction(noOpen, 'CLOCK_OUT').reason).toBe('CLOCK_OUT_WITHOUT_OPEN_SHIFT');
    const working = { shifts: [{ clockIn: '2024-01-01T09:00:00+09:00' }], now: '2024-01-01T10:00:00+09:00' };
    expect(decideClockAction(working, 'CLOCK_IN').reason).toBe('DOUBLE_CLOCK_IN');
  });

  it('warns at 16 hours and requires confirmation for a same-day re-entry', () => {
    expect(getAttendanceStatus({ shifts: [{ clockIn: '2024-01-01T08:00:00+09:00' }], now: '2024-01-02T00:00:00+09:00' })).toBe('LONG_SHIFT_WARNING');
    const reentry = { shifts: [{ clockIn: '2024-01-01T08:00:00+09:00', clockOut: '2024-01-01T12:00:00+09:00' }], now: '2024-01-01T13:00:00+09:00' };
    expect(decideClockAction(reentry, 'CLOCK_IN').decision).toBe('CONFIRM_REENTRY');
    expect(decideClockAction(reentry, 'CLOCK_IN', true).decision).toBe('ALLOW');
  });

  it('returns to ready after a completed shift belongs to the previous JST day', () => {
    expect(getAttendanceStatus({
      shifts: [{ clockIn: '2024-01-01T08:00:00+09:00', clockOut: '2024-01-01T12:00:00+09:00' }],
      now: '2024-01-02T00:00:00+09:00',
    })).toBe('READY_TO_CLOCK_IN');
  });

  it('rejects archived employees and closed months before any clock action', () => {
    expect(decideClockAction({ shifts: [], now: '2024-01-01T09:00:00+09:00', employeeArchived: true }, 'CLOCK_IN').reason).toBe('EMPLOYEE_ARCHIVED');
    expect(decideClockAction({ shifts: [], now: '2024-01-01T09:00:00+09:00', monthClosed: true }, 'CLOCK_IN').reason).toBe('MONTH_CLOSED');
  });
});

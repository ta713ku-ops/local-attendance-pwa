/**
 * Pure attendance rules.  All instants are epoch milliseconds; calendar work is
 * deliberately done with a fixed +09:00 offset, never the host time zone.
 */
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const HALF_HOUR_MS = 30 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;
export const SIXTEEN_HOURS_MS = 16 * 60 * 60 * 1000;
export const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export type Instant = number | Date | string;
export type CalculationStatus = 'CALCULATED' | 'NEEDS_REVIEW';
export type ReviewReason = 'NON_POSITIVE_ROUNDED_DURATION' | 'OVER_24_HOURS';

export interface ShiftCalculationInput {
  clockIn: Instant;
  clockOut: Instant;
  hourlyWageYen: number;
  /** Approved short-shift exception: calculate using the effective minute timestamps. */
  approvedActualMinutes?: boolean;
  /** Explicit management confirmation required before a shift over 24 hours can calculate. */
  approvedLongShiftReview?: boolean;
}

export interface CalculatedShift {
  status: CalculationStatus;
  reviewReason?: ReviewReason;
  clockInMs: number;
  clockOutMs: number;
  roundedClockInMs: number;
  roundedClockOutMs: number;
  calculationMethod: 'HALF_HOUR' | 'APPROVED_ACTUAL_MINUTES';
  workDateJst: string;
  monthJst: string;
  totalMinutes: number;
  nightMinutes: number;
  regularMinutes: number;
  /** Integer units of 1/240 yen. */
  pay240thYen: number;
}

export function toEpochMs(value: Instant): number {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : value;
  if (!Number.isFinite(ms)) throw new RangeError('Invalid instant');
  return ms;
}

export function formatJstDate(value: Instant): string {
  const date = new Date(toEpochMs(value) + JST_OFFSET_MS);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function formatJstMonth(value: Instant): string {
  return formatJstDate(value).slice(0, 7);
}

/** Clock-in is always rounded up to the next 30-minute boundary in JST. */
export function roundClockInUp(value: Instant): number {
  const ms = toEpochMs(value);
  return Math.ceil((ms + JST_OFFSET_MS) / HALF_HOUR_MS) * HALF_HOUR_MS - JST_OFFSET_MS;
}

/** Clock-out is always rounded down to the preceding 30-minute boundary in JST. */
export function roundClockOutDown(value: Instant): number {
  const ms = toEpochMs(value);
  return Math.floor((ms + JST_OFFSET_MS) / HALF_HOUR_MS) * HALF_HOUR_MS - JST_OFFSET_MS;
}

function minutesBetween(startMs: number, endMs: number): number {
  return Math.floor((endMs - startMs) / MINUTE_MS);
}

/** Number of whole minutes overlapping the recurring JST 22:00--05:00 night window. */
export function calculateNightMinutes(start: Instant, end: Instant): number {
  const startMs = toEpochMs(start);
  const endMs = toEpochMs(end);
  if (endMs <= startMs) return 0;
  const jstStartDay = Math.floor((startMs + JST_OFFSET_MS) / (24 * 60 * 60 * 1000));
  const jstEndDay = Math.floor((endMs - 1 + JST_OFFSET_MS) / (24 * 60 * 60 * 1000));
  let overlapMs = 0;
  for (let day = jstStartDay - 1; day <= jstEndDay; day += 1) {
    const dayStartUtc = day * 24 * 60 * 60 * 1000 - JST_OFFSET_MS;
    const nightStart = dayStartUtc + 22 * 60 * 60 * 1000;
    const nightEnd = dayStartUtc + 29 * 60 * 60 * 1000;
    overlapMs += Math.max(0, Math.min(endMs, nightEnd) - Math.max(startMs, nightStart));
  }
  return Math.floor(overlapMs / MINUTE_MS);
}

/** Returns a calculation preview or the reason an administrator must review it. */
export function calculateShift(input: ShiftCalculationInput): CalculatedShift {
  if (!Number.isInteger(input.hourlyWageYen) || input.hourlyWageYen < 0) {
    throw new RangeError('hourlyWageYen must be a non-negative integer');
  }
  const clockInMs = toEpochMs(input.clockIn);
  const clockOutMs = toEpochMs(input.clockOut);
  const roundedClockInMs = roundClockInUp(clockInMs);
  const roundedClockOutMs = roundClockOutDown(clockOutMs);
  const calculationMethod = input.approvedActualMinutes ? 'APPROVED_ACTUAL_MINUTES' : 'HALF_HOUR';
  const startMs = input.approvedActualMinutes ? clockInMs : roundedClockInMs;
  const endMs = input.approvedActualMinutes ? clockOutMs : roundedClockOutMs;
  const base: CalculatedShift = {
    status: 'NEEDS_REVIEW', clockInMs, clockOutMs, roundedClockInMs, roundedClockOutMs,
    calculationMethod, workDateJst: formatJstDate(clockInMs), monthJst: formatJstMonth(clockInMs),
    totalMinutes: 0, nightMinutes: 0, regularMinutes: 0, pay240thYen: 0,
  };
  // The short-shift exception only applies after an explicit approval.
  if (endMs <= startMs) return { ...base, reviewReason: 'NON_POSITIVE_ROUNDED_DURATION' };
  // Long-shift review is based on the effective source timestamps, not the
  // rounded interval.  Rounding must never hide a 24-hour-plus attendance.
  if (clockOutMs - clockInMs > TWENTY_FOUR_HOURS_MS && !input.approvedLongShiftReview) {
    return { ...base, reviewReason: 'OVER_24_HOURS' };
  }
  const totalMinutes = minutesBetween(startMs, endMs);
  const nightMinutes = calculateNightMinutes(startMs, endMs);
  // base pay: minutes * wage / 60; premium: night minutes * wage * .25 / 60.
  // Multiplication by 240 removes both denominators exactly.
  const pay240thYen = totalMinutes * input.hourlyWageYen * 4 + nightMinutes * input.hourlyWageYen;
  return { ...base, status: 'CALCULATED', totalMinutes, nightMinutes, regularMinutes: totalMinutes - nightMinutes, pay240thYen };
}

export interface MonthlyPaySummary {
  employeeId: string;
  monthJst: string;
  totalMinutes: number;
  regularMinutes: number;
  nightMinutes: number;
  pay240thYen: number;
  /** Rounded once at the employee-month level, half up. */
  roundedYen: number;
}

export interface MonthlyShift extends Pick<CalculatedShift, 'status' | 'monthJst' | 'totalMinutes' | 'regularMinutes' | 'nightMinutes' | 'pay240thYen'> {
  employeeId: string;
}

export function round240thYenHalfUp(value: number): number {
  if (!Number.isSafeInteger(value)) throw new RangeError('pay240thYen must be a safe integer');
  return value >= 0 ? Math.floor((value + 120) / 240) : Math.ceil((value - 120) / 240);
}

export function summarizeEmployeeMonth(employeeId: string, monthJst: string, shifts: readonly MonthlyShift[]): MonthlyPaySummary {
  const included = shifts.filter((shift) => shift.employeeId === employeeId && shift.monthJst === monthJst && shift.status === 'CALCULATED');
  const sum = (key: keyof Pick<MonthlyShift, 'totalMinutes' | 'regularMinutes' | 'nightMinutes' | 'pay240thYen'>) => included.reduce((total, shift) => total + shift[key], 0);
  const pay240thYen = sum('pay240thYen');
  return { employeeId, monthJst, totalMinutes: sum('totalMinutes'), regularMinutes: sum('regularMinutes'), nightMinutes: sum('nightMinutes'), pay240thYen, roundedYen: round240thYenHalfUp(pay240thYen) };
}

export type EmployeeAttendanceStatus = 'READY_TO_CLOCK_IN' | 'WORKING' | 'LONG_SHIFT_WARNING' | 'REENTRY_CONFIRMATION' | 'ARCHIVED' | 'MONTH_CLOSED';
export type ClockAction = 'CLOCK_IN' | 'CLOCK_OUT';
export type ClockDecision = 'ALLOW' | 'CONFIRM_REENTRY' | 'REJECT';
export type ClockRejection = 'DOUBLE_CLOCK_IN' | 'CLOCK_OUT_WITHOUT_OPEN_SHIFT' | 'EMPLOYEE_ARCHIVED' | 'MONTH_CLOSED';

export interface AttendanceShift { clockIn: Instant; clockOut?: Instant | null; }
export interface AttendanceStateInput { shifts: readonly AttendanceShift[]; now: Instant; employeeArchived?: boolean; monthClosed?: boolean; }

export function getAttendanceStatus(input: AttendanceStateInput): EmployeeAttendanceStatus {
  if (input.employeeArchived) return 'ARCHIVED';
  if (input.monthClosed) return 'MONTH_CLOSED';
  const nowMs = toEpochMs(input.now);
  const open = input.shifts.find((shift) => shift.clockOut == null);
  if (open) return nowMs - toEpochMs(open.clockIn) >= SIXTEEN_HOURS_MS ? 'LONG_SHIFT_WARNING' : 'WORKING';
  const today = formatJstDate(nowMs);
  return input.shifts.some((shift) => shift.clockOut != null && formatJstDate(shift.clockIn) === today) ? 'REENTRY_CONFIRMATION' : 'READY_TO_CLOCK_IN';
}

export function decideClockAction(input: AttendanceStateInput, action: ClockAction, reentryConfirmed = false): { decision: ClockDecision; status: EmployeeAttendanceStatus; reason?: ClockRejection } {
  const status = getAttendanceStatus(input);
  if (status === 'ARCHIVED') return { decision: 'REJECT', status, reason: 'EMPLOYEE_ARCHIVED' };
  if (status === 'MONTH_CLOSED') return { decision: 'REJECT', status, reason: 'MONTH_CLOSED' };
  if (action === 'CLOCK_OUT') {
    return status === 'WORKING' || status === 'LONG_SHIFT_WARNING'
      ? { decision: 'ALLOW', status }
      : { decision: 'REJECT', status, reason: 'CLOCK_OUT_WITHOUT_OPEN_SHIFT' };
  }
  if (status === 'WORKING' || status === 'LONG_SHIFT_WARNING') return { decision: 'REJECT', status, reason: 'DOUBLE_CLOCK_IN' };
  if (status === 'REENTRY_CONFIRMATION' && !reentryConfirmed) return { decision: 'CONFIRM_REENTRY', status };
  return { decision: 'ALLOW', status };
}

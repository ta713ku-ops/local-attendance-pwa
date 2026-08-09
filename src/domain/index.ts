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
  /** Regular-work hourly wage in whole yen. */
  hourlyWageYen: number;
  /**
   * Explicit night-work hourly wage in whole yen.  Legacy records omit this
   * value and retain the historical 25% premium calculation.
   */
  nightHourlyWageYen?: number;
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
  /** Regular-work pay, kept exactly in integer units of 1/240 yen. */
  regularPay240thYen: number;
  /** Night-work pay (base plus 25% premium), in integer units of 1/240 yen. */
  nightPay240thYen: number;
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
  if (input.nightHourlyWageYen !== undefined && (!Number.isInteger(input.nightHourlyWageYen) || input.nightHourlyWageYen < 0)) {
    throw new RangeError('nightHourlyWageYen must be a non-negative integer');
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
    regularPay240thYen: 0, nightPay240thYen: 0,
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
  // Multiplication by 240 keeps both the historical 25% premium and explicit
  // whole-yen night rates exact without floating-point rounding.
  const regularMinutes = totalMinutes - nightMinutes;
  const regularPay240thYen = regularMinutes * input.hourlyWageYen * 4;
  const nightPay240thYen = input.nightHourlyWageYen === undefined
    ? nightMinutes * input.hourlyWageYen * 5
    : nightMinutes * input.nightHourlyWageYen * 4;
  const pay240thYen = regularPay240thYen + nightPay240thYen;
  return { ...base, status: 'CALCULATED', totalMinutes, nightMinutes, regularMinutes, pay240thYen, regularPay240thYen, nightPay240thYen };
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

export type PayBreakdownComponent = 'REGULAR' | 'NIGHT';

/** A closed, reviewed shift eligible for employee-month rounding allocation. */
export interface PayAllocationShift {
  shiftId: string;
  employeeId: string;
  status: CalculationStatus | 'WORKING';
  /** The effective clock-in instant (actual or approved correction). */
  effectiveClockIn: Instant;
  /** Exact component amounts; integer units of 1/240 yen. */
  regularPay240thYen: number;
  nightPay240thYen: number;
}

export interface AllocatedPayComponent {
  component: PayBreakdownComponent;
  exact240thYen: number;
  /** Whole-yen amount after employee-month rounding and remainder allocation. */
  allocatedYen: number;
}

export interface AllocatedShiftPay {
  shiftId: string;
  effectiveWorkDateJst: string;
  effectiveClockInMs: number;
  regular: AllocatedPayComponent;
  night: AllocatedPayComponent;
  allocatedYen: number;
}

export interface EmployeeMonthPayAllocation {
  employeeId: string;
  monthJst: string;
  exact240thYen: number;
  roundedYen: number;
  shifts: AllocatedShiftPay[];
}

/**
 * Rounds once per employee-month, then deterministically assigns the remaining
 * yen to shift components by: remainder desc, work date asc, clock-in asc,
 * shift id asc, and REGULAR before NIGHT within the same shift.
 * WORKING and NEEDS_REVIEW records are intentionally excluded.
 */
export function allocateEmployeeMonthPay(
  employeeId: string,
  monthJst: string,
  shifts: readonly PayAllocationShift[],
): EmployeeMonthPayAllocation {
  type Candidate = {
    shift: PayAllocationShift;
    component: PayBreakdownComponent;
    exact240thYen: number;
    effectiveClockInMs: number;
    effectiveWorkDateJst: string;
    baseYen: number;
    remainder: number;
  };
  const candidates: Candidate[] = [];
  for (const shift of shifts) {
    const effectiveClockInMs = toEpochMs(shift.effectiveClockIn);
    if (shift.employeeId !== employeeId || shift.status !== 'CALCULATED' || formatJstMonth(effectiveClockInMs) !== monthJst) continue;
    for (const [component, exact240thYen] of [['REGULAR', shift.regularPay240thYen], ['NIGHT', shift.nightPay240thYen]] as const) {
      if (!Number.isSafeInteger(exact240thYen) || exact240thYen < 0) throw new RangeError('component pay must be a non-negative safe integer');
      candidates.push({ shift, component, exact240thYen, effectiveClockInMs, effectiveWorkDateJst: formatJstDate(effectiveClockInMs), baseYen: Math.floor(exact240thYen / 240), remainder: exact240thYen % 240 });
    }
  }
  const exact240thYen = candidates.reduce((sum, item) => sum + item.exact240thYen, 0);
  if (!Number.isSafeInteger(exact240thYen)) throw new RangeError('employee-month pay exceeds safe integer range');
  const roundedYen = round240thYenHalfUp(exact240thYen);
  const allocated = new Map<Candidate, number>(candidates.map((item) => [item, item.baseYen]));
  let remainingYen = roundedYen - candidates.reduce((sum, item) => sum + item.baseYen, 0);
  const ranked = [...candidates].sort((a, b) =>
    b.remainder - a.remainder
    || a.effectiveWorkDateJst.localeCompare(b.effectiveWorkDateJst)
    || a.effectiveClockInMs - b.effectiveClockInMs
    || a.shift.shiftId.localeCompare(b.shift.shiftId)
    || (a.component === b.component ? 0 : a.component === 'REGULAR' ? -1 : 1));
  for (let index = 0; index < remainingYen; index += 1) allocated.set(ranked[index], ranked[index].baseYen + 1);

  const byShift = new Map<string, AllocatedShiftPay>();
  for (const item of candidates) {
    const component: AllocatedPayComponent = { component: item.component, exact240thYen: item.exact240thYen, allocatedYen: allocated.get(item)! };
    const current = byShift.get(item.shift.shiftId) ?? {
      shiftId: item.shift.shiftId, effectiveWorkDateJst: item.effectiveWorkDateJst, effectiveClockInMs: item.effectiveClockInMs,
      regular: { component: 'REGULAR' as const, exact240thYen: 0, allocatedYen: 0 },
      night: { component: 'NIGHT' as const, exact240thYen: 0, allocatedYen: 0 }, allocatedYen: 0,
    };
    if (item.component === 'REGULAR') current.regular = component; else current.night = component;
    current.allocatedYen += component.allocatedYen;
    byShift.set(item.shift.shiftId, current);
  }
  return { employeeId, monthJst, exact240thYen, roundedYen, shifts: [...byShift.values()].sort((a, b) => a.effectiveClockInMs - b.effectiveClockInMs || a.shiftId.localeCompare(b.shiftId)) };
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

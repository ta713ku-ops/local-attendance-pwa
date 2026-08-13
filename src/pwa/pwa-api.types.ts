import type { Command, Result } from '../shared/api';

export type EmployeeStatus = 'ACTIVE' | 'ARCHIVED';
export type ShiftState = 'OPEN' | 'CALCULATED' | 'NEEDS_REVIEW';
export type CalculationMethod = 'HALF_HOUR' | 'ACTUAL_MINUTES';
export type BackupKind = 'AUTO' | 'MANUAL' | 'PRE_RESTORE';

export interface EmployeeDto {
  id: string;
  name: string;
  hourlyWage: number;
  /** Null means a legacy employee still using the historical 25% night premium. */
  nightHourlyWage: number | null;
  status: EmployeeStatus;
  archivedAt: number | null;
  restoreUntil: number | null;
}

export interface ClockEmployeeDto extends Omit<EmployeeDto, 'status'> {
  status: 'ACTIVE' | 'WORKING' | 'CLOCKED_OUT_TODAY';
  startedAt?: number;
}

export interface ClockStatusDto {
  id?: string;
  employeeId: string;
  businessDate: string | null;
  clockIn: number | null;
  clockOut: number | null;
  status: 'READY_TO_CLOCK_IN' | 'WORKING' | 'LONG_SHIFT_WARNING' | 'REENTRY_CONFIRMATION' | 'MONTH_CLOSED';
}

export interface ClockSaveDto {
  shiftId: string;
  employeeId: string;
  businessDate: string;
  clockIn: number;
  clockOut: number | null;
  state: ShiftState;
}

export interface PayBreakdownDto {
  totalMinutes: number;
  regularMinutes: number;
  nightMinutes: number;
  regularYen: number;
  nightYen: number;
  totalYen: number;
}

export interface AttendanceCalendarDto {
  month: string;
  today: string;
  attendanceDates: string[];
}

export interface AttendanceShiftDto {
  id: string;
  employeeId: string;
  employeeName: string;
  workDate: string;
  effectiveClockIn: number;
  effectiveClockOut: number | null;
  state: ShiftState;
  occurrenceOfDay: number;
  pay: PayBreakdownDto | null;
}

export interface AttendanceDayDto {
  date: string;
  shifts: AttendanceShiftDto[];
  totals: PayBreakdownDto & {
    attendanceCount: number;
    openCount: number;
    reviewCount: number;
  };
}

export interface CorrectionListItemDto {
  shiftId: string;
  employeeId: string;
  employeeName: string;
  workDate: string;
  effectiveClockIn: number;
  effectiveClockOut: number | null;
  state: ShiftState;
  corrected: boolean;
  legacyPending: boolean;
}

export interface CorrectionHistoryDto {
  id: string;
  startAt: number;
  endAt: number;
  hourlyWage: number;
  nightHourlyWage: number | null;
  reason: string;
  calculationMethod: CalculationMethod;
  longShiftConfirmed: boolean;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  appliedAt: number | null;
  createdAt: number;
}

export interface CorrectionDetailDto {
  shiftId: string;
  employeeId: string;
  employeeName: string;
  originalClockIn: number;
  originalClockOut: number | null;
  originalHourlyWage: number;
  originalNightHourlyWage: number | null;
  effectiveClockIn: number;
  effectiveClockOut: number | null;
  effectiveHourlyWage: number;
  effectiveNightHourlyWage: number | null;
  calculationMethod: CalculationMethod;
  longShiftConfirmed: boolean;
  currentPay: PayBreakdownDto | null;
  history: CorrectionHistoryDto[];
}

export interface CorrectionInput {
  shiftId: string;
  startAt: number;
  endAt: number;
  hourlyWage: number;
  /** Omitted only when preserving a legacy shift's historical 25% premium. */
  nightHourlyWage?: number;
  reason?: string;
  calculationMethod: CalculationMethod;
  longShiftConfirmed: boolean;
}

export interface CorrectionPreviewDto {
  before: CorrectionDetailDto;
  after: {
    workDate: string;
    month: string;
    pay: PayBreakdownDto | null;
    state: ShiftState;
  };
}

export interface MonthlyEmployeeDto extends PayBreakdownDto {
  employeeId: string;
  employeeName: string;
  attendanceCount: number;
}

export interface MonthlySummaryDto extends PayBreakdownDto {
  month: string;
  status: 'OPEN' | 'CLOSED';
  employees: MonthlyEmployeeDto[];
  attendanceCount: number;
  openCount: number;
  reviewCount: number;
  legacyPendingCount: number;
  canClose: boolean;
}

export interface MonthlyEmployeeDetailDto {
  month: string;
  employee: EmployeeDto;
  totals: MonthlyEmployeeDto;
  days: Array<{ date: string; shifts: AttendanceShiftDto[]; totals: PayBreakdownDto }>;
}

export interface AnnualEmployeeDto extends PayBreakdownDto {
  employeeId: string;
  employeeName: string;
  attendanceCount: number;
}

export interface AnnualSummaryDto extends PayBreakdownDto {
  year: string;
  employees: AnnualEmployeeDto[];
  attendanceCount: number;
}

export interface AnnualMonthDto extends PayBreakdownDto {
  month: string;
  attendanceCount: number;
}

export interface AnnualEmployeeDetailDto {
  year: string;
  employee: EmployeeDto;
  totals: AnnualEmployeeDto;
  months: AnnualMonthDto[];
}

export interface BackupStatusDto {
  lastBackupAt: number | null;
}

export interface PwaAttendanceApi {
  clock: {
    home(): Promise<Result<{ adminConfigured: boolean; employees: ClockEmployeeDto[] }>>;
    status(employeeId: string): Promise<Result<ClockStatusDto>>;
    clockIn(input: Command<{ employeeId: string; reClockAcknowledged?: boolean }>): Promise<Result<ClockSaveDto>>;
    clockOut(input: Command<{ employeeId: string }>): Promise<Result<ClockSaveDto>>;
  };
  adminAuth: {
    setup(input: Command<{ pin: string; displayName?: string }>): Promise<Result<{ recoveryCode: string }>>;
    verify(input: Command<{ pin: string }>): Promise<Result<{ authenticatedUntil: number }>>;
    lock(): Promise<void>;
    changePin(input: Command<{ oldPin: string; newPin: string }>): Promise<Result<{ changed: true }>>;
    resetWithRecovery(input: Command<{ recoveryCode: string; newPin: string }>): Promise<Result<{ recoveryCode: string }>>;
  };
  employees: {
    list(includeArchived?: boolean): Promise<Result<EmployeeDto[]>>;
    create(input: Command<{ name: string; hourlyWage: number; nightHourlyWage?: number }>): Promise<Result<EmployeeDto>>;
    update(input: Command<{ id: string; name?: string; hourlyWage?: number; nightHourlyWage?: number }>): Promise<Result<{ id: string }>>;
    archive(input: Command<{ id: string }>): Promise<Result<{ id: string; status: 'ARCHIVED' }>>;
    restore(input: Command<{ id: string }>): Promise<Result<{ id: string; status: 'ACTIVE' }>>;
    permanentlyDelete(input: Command<{ id: string }>): Promise<Result<never>>;
  };
  attendance: {
    calendar(month: string): Promise<Result<AttendanceCalendarDto>>;
    day(date: string): Promise<Result<AttendanceDayDto>>;
    createShift(input: Command<{ employeeId: string; workDate: string; startAt: number; endAt: number }>): Promise<Result<AttendanceShiftDto>>;
    correctionEmployees(): Promise<Result<EmployeeDto[]>>;
    correctionShifts(employeeId: string): Promise<Result<CorrectionListItemDto[]>>;
    correctionDetail(shiftId: string): Promise<Result<CorrectionDetailDto>>;
    previewCorrection(input: CorrectionInput): Promise<Result<CorrectionPreviewDto>>;
    applyCorrection(input: Command<CorrectionInput>): Promise<Result<CorrectionDetailDto>>;
    resolveLegacyCorrection(input: Command<{ correctionId: string; action: 'APPLY' | 'REJECT' }>): Promise<Result<CorrectionDetailDto>>;
    voidShift(input: Command<{ shiftId: string; adminPin: string }>): Promise<Result<{ shiftId: string; voidedAt: number }>>;
  };
  monthly: {
    summary(month: string): Promise<Result<MonthlySummaryDto>>;
    employeeDetail(month: string, employeeId: string): Promise<Result<MonthlyEmployeeDetailDto>>;
    close(input: Command<{ month: string }>): Promise<Result<MonthlySummaryDto>>;
    reopen(input: Command<{ month: string }>): Promise<Result<MonthlySummaryDto>>;
    exportCsv(month: string): Promise<Result<{ fileName: string; mimeType: string; csv: string }>>;
    print(month: string): Promise<Result<MonthlySummaryDto>>;
  };
  annual: {
    summary(year: string): Promise<Result<AnnualSummaryDto>>;
    employeeDetail(year: string, employeeId: string): Promise<Result<AnnualEmployeeDetailDto>>;
  };
  backup: {
    status(): Promise<Result<BackupStatusDto>>;
    prepareExport(): Promise<Result<{ fileName: string; json: string; createdAt: number }>>;
    markExportSaved(input: Command<{ createdAt: number }>): Promise<Result<{ lastBackupAt: number }>>;
    inspectImport(json: string): Promise<Result<{ createdAt: number }>>;
    restoreImport(input: Command<{ json: string }>): Promise<Result<{ restored: true; requiresReauthentication: true }>>;
  };
}

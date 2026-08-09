import type { BackupKind, CalculationMethod } from './pwa-api.types';

export type StoreName = 'meta' | 'employees' | 'shifts' | 'corrections' | 'exceptions' | 'periods' | 'logs' | 'receipts' | 'backups';
export type SnapshotStoreName = Exclude<StoreName, 'backups' | 'receipts'>;

export interface LocalEmployee {
  id: string; name: string; display_order?: number; status?: 'ACTIVE' | 'ARCHIVED';
  archived_at?: number | null; restore_until?: number | null; version?: number; hourly_wage: number;
  /** Missing on legacy records, which continue to use the historical 25% premium. */
  night_hourly_wage?: number;
}

export interface LocalShift {
  id: string; employee_id: string; business_date?: string; clock_in: number; clock_out?: number | null;
  wage_snapshot: number; calc_status?: 'OPEN' | 'CALCULATED' | 'NEEDS_REVIEW'; created_at?: number;
  night_wage_snapshot?: number;
  voided_at?: number | null; void_reason?: string | null;
}

export interface LocalCorrection {
  id: string; shift_id: string; start_at: number; end_at: number; reason?: string;
  hourly_wage?: number; night_hourly_wage?: number; calculation_method?: CalculationMethod; long_shift_confirmed?: boolean;
  status: 'PENDING' | 'APPROVED' | 'REJECTED'; applied_at?: number | null; created_at: number;
  decision_reason?: string; decided_at?: number;
}

export interface LocalException { id: string; shift_id: string; reason?: string; status: 'APPROVED'; approved_at: number }
export interface LocalPeriod { month: string; status: 'OPEN' | 'CLOSED'; closed_at?: number | null; reopened_at?: number | null }
export interface LocalLog { id: string; created_at: number; kind: string; target_id?: string | null; request_id?: string | null; result: string }
export interface LocalReceipt { requestId: string; kind: string; result: unknown; createdAt: number }

export interface LocalBackup {
  id: string; file_name: string; kind: BackupKind; status: 'SUCCESS' | 'FAILED'; size: number;
  created_at: number; error?: string | null; snapshot?: LocalBackupPayload;
}

export interface LocalBackupPayloadV1 {
  format: 'local-attendance-pwa-backup'; version: 1; exportedAt: number;
  stores: Partial<Record<StoreName, unknown[]>>;
}

export interface LocalBackupPayloadV2 {
  format: 'local-attendance-pwa-backup'; version: 2; exportedAt: number;
  stores: Record<SnapshotStoreName, unknown[]>;
}

export type LocalBackupPayload = LocalBackupPayloadV1 | LocalBackupPayloadV2;

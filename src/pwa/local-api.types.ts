export type StoreName = 'meta' | 'employees' | 'shifts' | 'corrections' | 'exceptions' | 'periods' | 'logs' | 'receipts' | 'backups';

export interface LocalEmployee {
  id: string; name: string; display_order: number; status: 'ACTIVE' | 'ARCHIVED';
  archived_at?: number | null; restore_until?: number | null; version: number; hourly_wage: number;
}

export interface LocalShift {
  id: string; employee_id: string; business_date: string; clock_in: number; clock_out?: number | null;
  wage_snapshot: number; calc_status: 'OPEN' | 'CALCULATED' | 'NEEDS_REVIEW'; created_at: number;
}

export interface LocalCorrection {
  id: string; shift_id: string; start_at: number; end_at: number; reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED'; created_at: number; decision_reason?: string; decided_at?: number;
}

export interface LocalException { id: string; shift_id: string; reason: string; status: 'APPROVED'; approved_at: number }
export interface LocalPeriod { month: string; status: 'OPEN' | 'CLOSED'; closed_at?: number | null }
export interface LocalLog { id: string; created_at: number; kind: string; target_id?: string | null; request_id?: string | null; result: string }
export interface LocalBackup { id: string; file_name: string; kind: string; status: 'SUCCESS'; size: number; created_at: number; snapshot: LocalBackupPayload }
export interface LocalReceipt { requestId: string; kind: string; result: unknown; createdAt: number }

export interface LocalBackupPayload {
  format: 'local-attendance-pwa-backup'; version: 1; exportedAt: number;
  stores: Partial<Record<StoreName, unknown[]>>;
}

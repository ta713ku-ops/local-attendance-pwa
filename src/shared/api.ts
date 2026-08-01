export type Result<T=unknown> = { ok:true; data:T; backupWarning?:string } | { ok:false; code:string; message:string; needsAuth?:boolean };
export type Command<T> = T & { requestId:string };
export interface AttendanceApi {
  clock: { home():Promise<Result<unknown>>; status(employeeId:string):Promise<Result<unknown>>; clockIn(input:Command<{employeeId:string}>):Promise<Result<unknown>>; clockOut(input:Command<{employeeId:string}>):Promise<Result<unknown>> };
  adminAuth: { setup(input:Command<{pin:string; displayName?:string}>):Promise<Result<{recoveryCode:string}>>; verify(input:Command<{pin:string}>):Promise<Result<{authenticatedUntil:number; requiresInitialPinChange:boolean; recoveryCode?:string}>>; lock():Promise<void>; changePin(input:Command<{oldPin:string; newPin:string}>):Promise<Result<unknown>>; resetWithRecovery(input:Command<{recoveryCode:string; newPin:string}>):Promise<Result<{recoveryCode:string}>> };
  employees: { list(includeArchived?:boolean):Promise<Result<unknown>>; create(input:Command<{name:string; hourlyWage:number}>):Promise<Result<unknown>>; update(input:Command<{id:string; name?:string; hourlyWage?:number; displayOrder?:number}>):Promise<Result<unknown>>; archive(input:Command<{id:string}>):Promise<Result<unknown>>; restore(input:Command<{id:string}>):Promise<Result<unknown>>; permanentlyDelete(input:Command<{id:string}>):Promise<Result<unknown>> };
  attendance: { list(query?:unknown):Promise<Result<unknown>>; detail(id:string):Promise<Result<unknown>>; proposeCorrection(input:Command<{shiftId:string; startAt:number; endAt:number; reason:string}>):Promise<Result<unknown>>; decideCorrection(input:Command<{id:string; approve:boolean; reason:string}>):Promise<Result<unknown>>; approveException(input:Command<{shiftId:string; reason:string}>):Promise<Result<unknown>> };
  monthly: { list():Promise<Result<unknown>>; detail(month:string):Promise<Result<unknown>>; close(input:Command<{month:string; reason:string}>):Promise<Result<unknown>>; reopen(input:Command<{month:string; reason:string}>):Promise<Result<unknown>>; exportCsv(month:string):Promise<Result<unknown>>; print(month:string):Promise<Result<unknown>> };
  operations: { dashboard():Promise<Result<unknown>>; logs(query?:unknown):Promise<Result<unknown>> };
  backup: { list():Promise<Result<unknown>>; create(input:Command<{kind?:string}>):Promise<Result<unknown>>; verify(id:string):Promise<Result<unknown>>; restore(input:Command<{id:string}>):Promise<Result<unknown>> };
  settings: { get():Promise<Result<unknown>>; update(input:Command<Record<string,unknown>>):Promise<Result<unknown>>; testSound():Promise<Result<unknown>> };
  app: { version():Promise<string>; quit():Promise<Result<unknown>> };
}
declare global { interface Window { attendance: AttendanceApi } }

import type { AttendanceApi, Result } from '../shared/api';
import { calculateShift, formatJstDate, formatJstMonth, getAttendanceStatus, summarizeEmployeeMonth, type CalculatedShift, type MonthlyShift } from '../domain';
import type { LocalBackup, LocalBackupPayload, LocalCorrection, LocalEmployee, LocalException, LocalLog, LocalPeriod, LocalReceipt, LocalShift, StoreName } from './local-api.types';

const DB_NAME = 'local-attendance-pwa';
const DB_VERSION = 1;
const STORES: StoreName[] = ['meta','employees','shifts','corrections','exceptions','periods','logs','receipts','backups'];
const encoder = new TextEncoder();
const ok = <T>(data: T): Result<T> => ({ ok: true, data });
const fail = (error: unknown, needsAuth = false): Result<never> => ({ ok: false, code: 'OPERATION_FAILED', message: error instanceof Error ? error.message : '操作に失敗しました。', needsAuth });
const uuid = () => globalThis.crypto.randomUUID();
const validatePin = (pin: string) => { if (!/^\d{6}$/.test(pin)) throw new Error('PINは6桁の数字です'); };
const csvCell = (value: unknown) => { let text = value == null ? '' : String(value); if (/^[=+\-@]/.test(text)) text = `'${text}`; return `"${text.replace(/"/g, '""')}"`; };

function request<T = unknown>(input: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { input.onsuccess = () => resolve(input.result); input.onerror = () => reject(input.error ?? new Error('IndexedDB error')); });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed')); tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted')); });
}

export function openLocalAttendanceDatabase(name = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(name, DB_VERSION);
    opening.onupgradeneeded = () => {
      const db = opening.result;
      for (const store of STORES) if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: store === 'meta' ? 'key' : store === 'receipts' ? 'requestId' : store === 'periods' ? 'month' : 'id' });
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error('ローカルデータを開けませんでした'));
  });
}

async function getAll<T>(db: IDBDatabase, store: StoreName): Promise<T[]> {
  const tx = db.transaction(store, 'readonly'); return request(tx.objectStore(store).getAll()) as Promise<T[]>;
}
async function getOne<T>(db: IDBDatabase, store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const tx = db.transaction(store, 'readonly'); return request(tx.objectStore(store).get(key)) as Promise<T | undefined>;
}
async function putOne(db: IDBDatabase, store: StoreName, value: unknown): Promise<void> {
  const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value); await transactionDone(tx);
}
async function deleteOne(db: IDBDatabase, store: StoreName, key: IDBValidKey): Promise<void> {
  const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).delete(key); await transactionDone(tx);
}
async function meta<T>(db: IDBDatabase, key: string): Promise<T | undefined> { return (await getOne<{key:string;value:T}>(db,'meta',key))?.value; }
async function setMeta(db: IDBDatabase, key: string, value: unknown) { await putOne(db, 'meta', { key, value }); }

function bytesToBase64(value: Uint8Array) { let s=''; for (const byte of value) s += String.fromCharCode(byte); return btoa(s); }
function base64ToBytes(value: string) { const s=atob(value); return Uint8Array.from(s, (c) => c.charCodeAt(0)); }
function randomSecret(bytes = 24) { const value = new Uint8Array(bytes); globalThis.crypto.getRandomValues(value); return bytesToBase64(value).replace(/[+/=]/g, ''); }
async function hashSecret(secret: string, salt?: Uint8Array) {
  const actualSalt = salt ?? globalThis.crypto.getRandomValues(new Uint8Array(16));
  const key = await globalThis.crypto.subtle.importKey('raw', encoder.encode(secret), 'PBKDF2', false, ['deriveBits']);
  const digest = await globalThis.crypto.subtle.deriveBits({ name:'PBKDF2', salt:actualSalt, iterations:310_000, hash:'SHA-256' }, key, 256);
  return `pbkdf2-sha256:310000:${bytesToBase64(actualSalt)}:${bytesToBase64(new Uint8Array(digest))}`;
}
async function checkSecret(secret: string, stored: string) {
  const [algorithm, iterations, salt, digest] = stored.split(':');
  if (algorithm !== 'pbkdf2-sha256' || iterations !== '310000' || !salt || !digest) return false;
  const actual = await hashSecret(secret, base64ToBytes(salt));
  const a=encoder.encode(actual), b=encoder.encode(stored); if (a.length !== b.length) return false;
  let difference=0; for(let i=0;i<a.length;i+=1) difference |= a[i]^b[i]; return difference===0;
}

type AdminRecord = { pinHash:string; recoveryHash:string; displayName:string; failedCount:number; lockedUntil:number };

export interface LocalAttendanceController {
  api: AttendanceApi;
  exportBackupJson(): Promise<string>;
  importBackupJson(json: string): Promise<Result<{ imported: true }>>;
  close(): void;
}

export async function createLocalAttendanceApi(options: { dbName?: string; now?: () => number } = {}): Promise<LocalAttendanceController> {
  const db = await openLocalAttendanceDatabase(options.dbName);
  const now = options.now ?? Date.now;
  let adminUntil = 0;
  let writeQueue: Promise<void> = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = writeQueue.then(operation, operation);
    writeQueue = next.then(() => undefined, () => undefined);
    return next;
  };
  const requireAdmin = () => { if (now() > adminUntil) throw new Error('再認証が必要です'); };
  const withRead = async <T>(operation:()=>Promise<T>, admin=true):Promise<Result<T>> => { try { if(admin) requireAdmin(); return ok(await operation()); } catch(error){ return fail(error, admin); } };
  const log = async (kind:string,target?:string,requestId?:string) => putOne(db,'logs',{id:uuid(),created_at:now(),kind,target_id:target??null,request_id:requestId??null,result:'SUCCESS'} satisfies LocalLog);
  const command = <T>(kind:string,input:{requestId:string},operation:()=>Promise<T>,admin=true,persistReceipt=true):Promise<Result<T>> => serialized(async () => {
    try {
      if(admin) requireAdmin();
      if(!input?.requestId) throw new Error('requestIdが必要です');
      const previous=persistReceipt ? await getOne<LocalReceipt>(db,'receipts',input.requestId) : undefined;
      if(previous) return previous.kind===kind ? previous.result as Result<T> : {ok:false,code:'REQUEST_ID_REUSED',message:'requestId は別の操作に再利用できません。'};
      const result=ok(await operation());
      // Recovery codes are one-time secrets; callers disable receipts for commands
      // whose result contains one so no usable secret is ever persisted in plaintext.
      if(persistReceipt) await putOne(db,'receipts',{requestId:input.requestId,kind,result,createdAt:now()} satisfies LocalReceipt);
      return result;
    } catch(error){ return fail(error,admin); }
  });
  const activePeriodClosed = async (timestamp:number) => (await getOne<LocalPeriod>(db,'periods',formatJstMonth(timestamp)))?.status==='CLOSED';
  const effectiveCalculation = async (shift:LocalShift):Promise<CalculatedShift|null> => {
    if(shift.clock_out==null) return null;
    const correction=(await getAll<LocalCorrection>(db,'corrections')).filter(x=>x.shift_id===shift.id&&x.status==='APPROVED').sort((a,b)=>b.created_at-a.created_at)[0];
    const exception=(await getAll<LocalException>(db,'exceptions')).some(x=>x.shift_id===shift.id&&x.status==='APPROVED');
    return calculateShift({clockIn:correction?.start_at??shift.clock_in,clockOut:correction?.end_at??shift.clock_out,hourlyWageYen:shift.wage_snapshot,approvedActualMinutes:exception,approvedLongShiftReview:exception});
  };
  const calculatedRows = async (month?:string) => {
    const [shifts,employees,corrections]=await Promise.all([getAll<LocalShift>(db,'shifts'),getAll<LocalEmployee>(db,'employees'),getAll<LocalCorrection>(db,'corrections')]);
    const employeeMap=new Map(employees.map(x=>[x.id,x]));
    const selected=shifts.filter(x=>!month||x.business_date.startsWith(month)).sort((a,b)=>b.created_at-a.created_at);
    return Promise.all(selected.map(async row=>{
      const pendingCorrection=corrections.find(x=>x.shift_id===row.id&&x.status==='PENDING')??null;
      return {...row,employee_name:employeeMap.get(row.employee_id)?.name??'削除済み',calculation:await effectiveCalculation(row),pendingCorrection};
    }));
  };

  const exportPayload = async ():Promise<LocalBackupPayload> => {
    const stores:Partial<Record<StoreName,unknown[]>>={};
    for(const store of STORES.filter(x=>x!=='backups'&&x!=='receipts')) stores[store]=await getAll(db,store);
    return {format:'local-attendance-pwa-backup',version:1,exportedAt:now(),stores};
  };
  const exportBackupJson = async () => { requireAdmin(); return JSON.stringify(await exportPayload()); };
  const importBackupJson = async (json:string):Promise<Result<{imported:true}>> => {
    try {
      requireAdmin();
      const payload=JSON.parse(json) as LocalBackupPayload;
      if(payload.format!=='local-attendance-pwa-backup'||payload.version!==1||!payload.stores) throw new Error('対応していないバックアップです');
      const names=STORES.filter(x=>x!=='backups'&&x!=='receipts');
      const tx=db.transaction(names,'readwrite');
      for(const name of names){ const store=tx.objectStore(name); store.clear(); for(const item of payload.stores[name]??[]) store.put(item); }
      await transactionDone(tx); adminUntil=0; return ok({imported:true});
    } catch(error){ return fail(error,true); }
  };

  const api:AttendanceApi = {
    clock:{
      home:()=>withRead(async()=>{
        const [administrator,employees,shifts]=await Promise.all([meta<AdminRecord>(db,'administrator'),getAll<LocalEmployee>(db,'employees'),getAll<LocalShift>(db,'shifts')]);
        const today=formatJstDate(now());
        const rows=employees.filter(x=>x.status==='ACTIVE').sort((a,b)=>a.display_order-b.display_order);
        return {adminConfigured:Boolean(administrator),requiresInitialPinChange:false,employees:rows.map(employee=>{
          const employeeShifts=shifts.filter(shift=>shift.employee_id===employee.id);
          const open=employeeShifts.find(shift=>shift.clock_out==null);
          const clockedOutToday=employeeShifts.some(shift=>shift.clock_out!=null&&shift.business_date===today);
          return {...employee,status:open?'WORKING':clockedOutToday?'CLOCKED_OUT_TODAY':'OFF',startedAt:open?.clock_in};
        })};
      },false),
      status:(employeeId)=>withRead(async()=>{ const employee=await getOne<LocalEmployee>(db,'employees',employeeId); if(!employee) throw new Error('従業員が見つかりません'); const shifts=(await getAll<LocalShift>(db,'shifts')).filter(x=>x.employee_id===employeeId); const latest=shifts.sort((a,b)=>b.created_at-a.created_at)[0]; return latest ? {...latest,status:getAttendanceStatus({shifts:shifts.map(x=>({clockIn:x.clock_in,clockOut:x.clock_out})),now:now(),employeeArchived:employee.status==='ARCHIVED',monthClosed:await activePeriodClosed(now())})} : undefined; },false),
      clockIn:(input)=>command('clock:in',input,async()=>{ const employee=await getOne<LocalEmployee>(db,'employees',input.employeeId); if(!employee||employee.status!=='ACTIVE') throw new Error('従業員が見つかりません'); if(await activePeriodClosed(now())) throw new Error('月締め済みです'); const shifts=await getAll<LocalShift>(db,'shifts'); if(shifts.some(x=>x.employee_id===employee.id&&x.clock_out==null)) throw new Error('すでに出勤中です'); const completedToday=shifts.some(x=>x.employee_id===employee.id&&x.clock_out!=null&&x.business_date===formatJstDate(now())); if(completedToday&&(input as typeof input & {reClockAcknowledged?:boolean}).reClockAcknowledged!==true) throw new Error('本日は退勤済みです。再出勤を確認してください'); const at=now(); const shift:LocalShift={id:uuid(),employee_id:employee.id,business_date:formatJstDate(at),clock_in:at,wage_snapshot:employee.hourly_wage,calc_status:'OPEN',created_at:at}; await putOne(db,'shifts',shift); await log('CLOCK_IN',employee.id,input.requestId); return shift; },false),
      clockOut:(input)=>command('clock:out',input,async()=>{ const shift=(await getAll<LocalShift>(db,'shifts')).find(x=>x.employee_id===input.employeeId&&x.clock_out==null); if(!shift) throw new Error('出勤中の勤務がありません'); if(await activePeriodClosed(shift.clock_in)) throw new Error('月締め済みです'); const at=now(); if(at<=shift.clock_in) throw new Error('端末時刻を確認してください。退勤は保存されていません。'); const calculation=calculateShift({clockIn:shift.clock_in,clockOut:at,hourlyWageYen:shift.wage_snapshot}); const updated={...shift,clock_out:at,calc_status:calculation.status}; await putOne(db,'shifts',updated); await log('CLOCK_OUT',shift.id,input.requestId); return {...updated,calculation}; },false),
    },
    adminAuth:{
      setup:(input)=>command('auth:setup',input,async()=>{ validatePin(input.pin); if(await meta(db,'administrator')) throw new Error('初期設定済みです'); const recoveryCode=randomSecret(); const admin:AdminRecord={pinHash:await hashSecret(input.pin),recoveryHash:await hashSecret(recoveryCode),displayName:input.displayName?.trim()||'管理者',failedCount:0,lockedUntil:0}; await setMeta(db,'administrator',admin); adminUntil=now()+300_000; return {recoveryCode}; },false,false),
      verify:async(input)=>{ try{ validatePin(input.pin); const admin=await meta<AdminRecord>(db,'administrator'); if(!admin) throw new Error('初期設定が必要です'); if(admin.lockedUntil>now()) throw new Error('PINは一時ロック中です'); if(!(await checkSecret(input.pin,admin.pinHash))){ const failedCount=admin.failedCount+1; const wait=failedCount>=5?Math.min(900_000,30_000*2**(failedCount-5)):0; await setMeta(db,'administrator',{...admin,failedCount,lockedUntil:now()+wait}); throw new Error('PINが正しくありません'); } adminUntil=now()+300_000; await setMeta(db,'administrator',{...admin,failedCount:0,lockedUntil:0}); return ok({authenticatedUntil:adminUntil,requiresInitialPinChange:false}); }catch(error){return fail(error);}},
      lock:async()=>{adminUntil=0;},
      changePin:(input)=>command('auth:change',input,async()=>{ validatePin(input.newPin); const admin=await meta<AdminRecord>(db,'administrator'); if(!admin||!(await checkSecret(input.oldPin,admin.pinHash))) throw new Error('現在のPINが正しくありません'); await setMeta(db,'administrator',{...admin,pinHash:await hashSecret(input.newPin),failedCount:0,lockedUntil:0}); adminUntil=now()+300_000; return {changed:true}; }),
      resetWithRecovery:(input)=>command('auth:recover',input,async()=>{ validatePin(input.newPin); const admin=await meta<AdminRecord>(db,'administrator'); if(!admin||!(await checkSecret(input.recoveryCode,admin.recoveryHash))) throw new Error('回復コードが正しくありません'); const recoveryCode=randomSecret(); await setMeta(db,'administrator',{...admin,pinHash:await hashSecret(input.newPin),recoveryHash:await hashSecret(recoveryCode),failedCount:0,lockedUntil:0}); adminUntil=now()+300_000; return {recoveryCode}; },false,false),
    },
    employees:{
      list:(includeArchived)=>withRead(async()=> (await getAll<LocalEmployee>(db,'employees')).filter(x=>includeArchived||x.status==='ACTIVE').sort((a,b)=>a.display_order-b.display_order)),
      create:(input)=>command('employees:create',input,async()=>{ const name=input.name.trim(); if(!name||name.length>80) throw new Error('氏名を入力してください'); if(!Number.isInteger(input.hourlyWage)||input.hourlyWage<=0) throw new Error('時給を確認してください'); const employees=await getAll<LocalEmployee>(db,'employees'); const employee:LocalEmployee={id:uuid(),name,hourly_wage:input.hourlyWage,display_order:Math.max(0,...employees.map(x=>x.display_order))+1,status:'ACTIVE',version:1}; await putOne(db,'employees',employee); await log('EMPLOYEE_CREATE',employee.id,input.requestId); return employee; }),
      update:(input)=>command('employees:update',input,async()=>{ const employee=await getOne<LocalEmployee>(db,'employees',input.id); if(!employee) throw new Error('従業員が見つかりません'); if(input.name!==undefined&&!input.name.trim()) throw new Error('氏名を入力してください'); if(input.hourlyWage!==undefined&&(!Number.isInteger(input.hourlyWage)||input.hourlyWage<=0)) throw new Error('時給を確認してください'); const updated={...employee,...(input.name!==undefined?{name:input.name.trim()}:{}),...(input.hourlyWage!==undefined?{hourly_wage:input.hourlyWage}:{}),...(input.displayOrder!==undefined?{display_order:input.displayOrder}:{}),version:employee.version+1}; await putOne(db,'employees',updated); await log('EMPLOYEE_UPDATE',input.id,input.requestId); return {id:input.id}; }),
      archive:(input)=>command('employees:archive',input,async()=>{ const employee=await getOne<LocalEmployee>(db,'employees',input.id); if(!employee) throw new Error('従業員が見つかりません'); if((await getAll<LocalShift>(db,'shifts')).some(x=>x.employee_id===input.id&&x.clock_out==null)) throw new Error('出勤中の従業員は削除できません'); const at=now(); await putOne(db,'employees',{...employee,status:'ARCHIVED',archived_at:at,restore_until:at+30*86_400_000}); await log('EMPLOYEE_ARCHIVE',input.id,input.requestId); return {id:input.id,status:'ARCHIVED'}; }),
      restore:(input)=>command('employees:restore',input,async()=>{ const employee=await getOne<LocalEmployee>(db,'employees',input.id); if(!employee||employee.status!=='ARCHIVED') throw new Error('削除済み従業員が見つかりません'); if((employee.restore_until??0)<now()) throw new Error('復元可能な30日間を過ぎています'); await putOne(db,'employees',{...employee,status:'ACTIVE',archived_at:null,restore_until:null}); await log('EMPLOYEE_RESTORE',input.id,input.requestId); return {id:input.id,status:'ACTIVE'}; }),
      permanentlyDelete:(input)=>command('employees:permanently-delete',input,async()=>{ const employee=await getOne<LocalEmployee>(db,'employees',input.id); if(!employee||employee.status!=='ARCHIVED') throw new Error('完全に削除できるのは削除済みの従業員だけです'); const shifts=(await getAll<LocalShift>(db,'shifts')).filter(x=>x.employee_id===input.id); const shiftIds=new Set(shifts.map(x=>x.id)); const tx=db.transaction(['employees','shifts','corrections','exceptions'],'readwrite'); tx.objectStore('employees').delete(input.id); for(const shift of shifts) tx.objectStore('shifts').delete(shift.id); for(const row of await request<LocalCorrection[]>(tx.objectStore('corrections').getAll())) if(shiftIds.has(row.shift_id)) tx.objectStore('corrections').delete(row.id); for(const row of await request<LocalException[]>(tx.objectStore('exceptions').getAll())) if(shiftIds.has(row.shift_id)) tx.objectStore('exceptions').delete(row.id); await transactionDone(tx); await log('EMPLOYEE_PERMANENTLY_DELETE',input.id,input.requestId); return {id:input.id,deleted:true}; }),
    },
    attendance:{
      list:(query)=>withRead(async()=>{ const rows=await calculatedRows(); const reviewOnly=Boolean((query as {reviewOnly?:unknown}|null)?.reviewOnly); return reviewOnly?rows.filter(row=>row.calculation?.status==='NEEDS_REVIEW'||row.calc_status==='NEEDS_REVIEW'||row.pendingCorrection!=null):rows; }), detail:(id)=>withRead(async()=>{const rows=await calculatedRows(); return rows.find(x=>x.id===id)??null;}),
      proposeCorrection:(input)=>command('attendance:propose',input,async()=>{ if(input.endAt<=input.startAt) throw new Error('退勤は出勤より後にしてください'); const shift=await getOne<LocalShift>(db,'shifts',input.shiftId); if(!shift) throw new Error('勤務が見つかりません'); if(await activePeriodClosed(shift.clock_in)) throw new Error('月締め済みです'); if((await getAll<LocalCorrection>(db,'corrections')).some(x=>x.shift_id===input.shiftId&&x.status==='PENDING')) throw new Error('承認待ちの修正があります'); const row:LocalCorrection={id:uuid(),shift_id:input.shiftId,start_at:input.startAt,end_at:input.endAt,reason:input.reason.trim(),status:'PENDING',created_at:now()}; await putOne(db,'corrections',row); await log('CORRECTION_PROPOSE',input.shiftId,input.requestId); return {id:row.id}; }),
      decideCorrection:(input)=>command('attendance:decide',input,async()=>{ const correction=await getOne<LocalCorrection>(db,'corrections',input.id); if(!correction||correction.status!=='PENDING') throw new Error('承認待ちの修正が見つかりません'); const status=input.approve?'APPROVED':'REJECTED'; await putOne(db,'corrections',{...correction,status,decision_reason:input.reason.trim(),decided_at:now()}); const shift=await getOne<LocalShift>(db,'shifts',correction.shift_id); if(shift&&shift.clock_out!=null){ const calculation=await effectiveCalculation(shift); if(calculation) await putOne(db,'shifts',{...shift,calc_status:calculation.status}); } await log('CORRECTION_DECIDE',input.id,input.requestId); return {id:input.id,status}; }),
      approveException:(input)=>command('attendance:exception',input,async()=>{ const shift=await getOne<LocalShift>(db,'shifts',input.shiftId); if(!shift||shift.clock_out==null) throw new Error('完了した勤務が見つかりません'); const preview=calculateShift({clockIn:shift.clock_in,clockOut:shift.clock_out,hourlyWageYen:shift.wage_snapshot}); if(preview.status!=='NEEDS_REVIEW') throw new Error('例外承認が必要な勤務ではありません'); await putOne(db,'exceptions',{id:uuid(),shift_id:shift.id,reason:input.reason.trim(),status:'APPROVED',approved_at:now()} satisfies LocalException); await putOne(db,'shifts',{...shift,calc_status:'CALCULATED'}); await log('CALCULATION_EXCEPTION',shift.id,input.requestId); return {approved:true}; }),
    },
    monthly:{
      list:()=>withRead(async()=>{ const shifts=await getAll<LocalShift>(db,'shifts'); const periods=new Map((await getAll<LocalPeriod>(db,'periods')).map(x=>[x.month,x])); const months=[...new Set(shifts.map(x=>x.business_date.slice(0,7)))].sort().reverse(); return months.map(month=>{const rows=shifts.filter(x=>x.business_date.startsWith(month)); return {month,shifts:rows.length,openShifts:rows.filter(x=>x.clock_out==null).length,reviewShifts:rows.filter(x=>x.calc_status==='NEEDS_REVIEW').length,status:periods.get(month)?.status??'OPEN'};});}),
      detail:(month)=>withRead(async()=>{ if(!/^\d{4}-\d{2}$/.test(month)) throw new Error('対象月を確認してください'); const rows=await calculatedRows(month); const employees=new Map<string,{id:string;name:string}>(); const shifts:MonthlyShift[]=[]; for(const row of rows){employees.set(row.employee_id,{id:row.employee_id,name:row.employee_name}); if(row.calculation) shifts.push({employeeId:row.employee_id,...row.calculation});} return [...employees.values()].map(employee=>({name:employee.name,...summarizeEmployeeMonth(employee.id,month,shifts)}));}),
      close:(input)=>command('monthly:close',input,async()=>{ if(!/^\d{4}-\d{2}$/.test(input.month)) throw new Error('対象月を確認してください'); const shifts=(await getAll<LocalShift>(db,'shifts')).filter(x=>x.business_date.startsWith(input.month)); if(shifts.some(x=>x.clock_out==null||x.calc_status==='NEEDS_REVIEW')) throw new Error('未退勤または要確認の勤務があります'); const period:LocalPeriod={month:input.month,status:'CLOSED',closed_at:now()}; await putOne(db,'periods',period); await log('MONTH_CLOSE',input.month,input.requestId); return period;}),
      reopen:(input)=>command('monthly:reopen',input,async()=>{ const period=await getOne<LocalPeriod>(db,'periods',input.month); if(!period||period.status!=='CLOSED') throw new Error('月締めされていません'); const updated:LocalPeriod={month:input.month,status:'OPEN',closed_at:null}; await putOne(db,'periods',updated); await log('MONTH_REOPEN',input.month,input.requestId); return updated;}),
      exportCsv:(month)=>withRead(async()=>{ const header=['氏名','勤務日','元出勤','元退勤','丸め出勤','丸め退勤','計算方式','通常分','深夜分','時給','1/240円単位','状態']; const lines=(await calculatedRows(month)).map(row=>[row.employee_name,row.business_date,row.clock_in,row.clock_out,row.calculation?.roundedClockInMs,row.calculation?.roundedClockOutMs,row.calculation?.calculationMethod,row.calculation?.regularMinutes,row.calculation?.nightMinutes,row.wage_snapshot,row.calculation?.pay240thYen,row.calculation?.status].map(csvCell).join(',')); lines.push(csvCell('注意: 残業・休日・控除等を含まない30分丸めの参考値です。')); return {fileName:`給与見込み-${month}.csv`,mimeType:'text/csv;charset=utf-8',csv:`\uFEFF${header.map(csvCell).join(',')}\r\n${lines.join('\r\n')}`};}),
      print:()=>withRead(async()=>({printRequested:false})),
    },
    operations:{ dashboard:()=>withRead(async()=>{const [employees,shifts,backups]=await Promise.all([getAll<LocalEmployee>(db,'employees'),getAll<LocalShift>(db,'shifts'),getAll<LocalBackup>(db,'backups')]); return {employees:{n:employees.filter(x=>x.status==='ACTIVE').length},openShifts:{n:shifts.filter(x=>x.clock_out==null).length},reviewShifts:{n:shifts.filter(x=>x.calc_status==='NEEDS_REVIEW').length},latestBackup:backups.sort((a,b)=>b.created_at-a.created_at)[0]??null};}), logs:()=>withRead(async()=>(await getAll<LocalLog>(db,'logs')).sort((a,b)=>b.created_at-a.created_at).slice(0,200)) },
    settings:{ get:()=>withRead(async()=>{const value=await meta<Record<string,unknown>>(db,'settings'); return Object.entries(value??{homeTimeoutSeconds:30,adminLockMinutes:5,backupGenerations:50,soundEnabled:true}).map(([key,value])=>({key,value:JSON.stringify(value)}));}), update:(input)=>command('settings:update',input,async()=>{const current=await meta<Record<string,unknown>>(db,'settings')??{}; const entries=Object.entries(input).filter(([key])=>key!=='requestId'); await setMeta(db,'settings',{...current,...Object.fromEntries(entries)}); return {updated:entries.map(([key])=>key)};}), testSound:()=>withRead(async()=>({played:false})) },
    backup:{ list:()=>withRead(async()=> (await getAll<LocalBackup>(db,'backups')).sort((a,b)=>b.created_at-a.created_at).map(({snapshot,...item})=>item)), create:(input)=>command('backup:create',input,async()=>{const snapshot=await exportPayload(); const json=JSON.stringify(snapshot); const backup:LocalBackup={id:uuid(),file_name:`${new Date(now()).toISOString().replace(/[:.]/g,'-')}-${input.kind??'MANUAL'}.json`,kind:input.kind??'MANUAL',status:'SUCCESS',size:encoder.encode(json).byteLength,created_at:now(),snapshot}; await putOne(db,'backups',backup); return {id:backup.id,fileName:backup.file_name,json};}), verify:(id)=>withRead(async()=>({valid:Boolean(await getOne(db,'backups',id))})), restore:(input)=>command('backup:restore',input,async()=>{const backup=await getOne<LocalBackup>(db,'backups',input.id); if(!backup) throw new Error('バックアップがありません'); const result=await importBackupJson(JSON.stringify(backup.snapshot)); if(!result.ok) throw new Error(result.message); return {restored:true};}) },
    app:{version:async()=> 'pwa-0.2.0',quit:()=>withRead(async()=>({closed:false}),false)},
  };
  return {api,exportBackupJson,importBackupJson,close:()=>db.close()};
}

let installedController: LocalAttendanceController | undefined;

export async function installLocalAttendanceApi(target: Window = window, options: { dbName?: string; now?: () => number } = {}): Promise<LocalAttendanceController> {
  const controller=await createLocalAttendanceApi(options);
  try {
    Object.defineProperty(target,'attendance',{value:Object.freeze(controller.api),configurable:true,writable:false});
  } catch (error) {
    controller.close();
    throw error;
  }
  installedController?.close();
  installedController=controller;
  return controller;
}

/** Import a user-selected JSON backup into the currently installed local API. */
export async function restoreBackupFile(file: File): Promise<Result<{ imported: true }>> {
  if(!installedController) return {ok:false,code:'NOT_INITIALIZED',message:'ローカル勤怠データが開始されていません。'};
  if(!file||typeof file.text!=='function') return {ok:false,code:'INVALID_BACKUP_FILE',message:'バックアップファイルを選択してください。'};
  try { return await installedController.importBackupJson(await file.text()); }
  catch(error) { return fail(error,true); }
}

/** Build a downloadable backup without persisting another backup generation. */
export async function exportBackup(): Promise<{fileName:string;json:string}> {
  if(!installedController) throw new Error('ローカル勤怠データが開始されていません。');
  const json=await installedController.exportBackupJson();
  return {fileName:`local-attendance-${new Date().toISOString().replace(/[:.]/g,'-')}.json`,json};
}

/** Compatibility name used by the PWA bootstrap. */
export const installWebAttendanceApi = installLocalAttendanceApi;

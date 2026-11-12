// Reference contract for the connected beta. The local demo engine is separate.
// All monetary values stay BigInt internally and travel over JSON as strings.
export const ECONOMY_VERSION='backing-v1';
export const INITIAL_CREDITS_CENTS=100_000n;
export const MIN_BACKING_CENTS=100n;
export const LOT_QUANTA=1_000_000_000_000n;
export const MAX_CENTS=9_223_372_036_854_775_807n;
export const MAX_LISTENERS=1_000_000_000_000n;
export const UPDATE_INTERVAL_MS=12*60*60*1000;
export const UPDATE_GRACE_MS=2*60*60*1000;
export const MAX_BASELINE_AGE_MS=24*60*60*1000;

function integer(value: bigint,min: bigint,max: bigint,label: string){
  if(typeof value!=='bigint'||value<min||value>max)throw new RangeError(`Invalid ${label}`);
}
function time(value: number){return Number.isSafeInteger(value)&&value>=0;}

export function parseCreditCents(input: string): bigint {
  if(typeof input!=='string'||!/^\d{1,17}(?:\.\d{1,2})?$/.test(input))throw new RangeError('Use a decimal Credit amount with at most two places');
  const [whole,fraction='']=input.split('.');
  const cents=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  integer(cents,0n,MAX_CENTS,'Credit amount');
  return cents;
}
export function validateBackingAmount(cents: bigint,availableCents: bigint){
  integer(availableCents,0n,MAX_CENTS,'available Credits');
  integer(cents,MIN_BACKING_CENTS,availableCents,'backing amount');
}
export function nextUpdateCutoff(acceptedAtMs: number){
  if(!time(acceptedAtMs))throw new RangeError('Invalid server time');
  const cutoff=(Math.floor(acceptedAtMs/UPDATE_INTERVAL_MS)+1)*UPDATE_INTERVAL_MS;
  if(!time(cutoff))throw new RangeError('Update time out of range');
  return cutoff;
}
export function baselineIsFresh(observedAtMs: number,nowMs: number){
  return time(observedAtMs)&&time(nowMs)&&nowMs>=observedAtMs&&nowMs-observedAtMs<=MAX_BASELINE_AGE_MS;
}
export interface SnapshotEligibility {
  orderAcceptedAtMs: number;
  cutoffMs: number;
  observedAtMs: number;
  acceptedAtMs: number;
  executionAtMs: number;
  lastSettledCutoffMs: number;
  valid: boolean;
  artistActive: boolean;
}
export function snapshotCanExecute(input: SnapshotEligibility){
  const {orderAcceptedAtMs,cutoffMs,observedAtMs,acceptedAtMs,executionAtMs,lastSettledCutoffMs,valid,artistActive}=input;
  if(!valid||!artistActive||![orderAcceptedAtMs,cutoffMs,observedAtMs,acceptedAtMs,executionAtMs,lastSettledCutoffMs].every(time))return false;
  return cutoffMs%UPDATE_INTERVAL_MS===0&&orderAcceptedAtMs<cutoffMs&&cutoffMs>lastSettledCutoffMs&&
    observedAtMs>=cutoffMs&&acceptedAtMs>=observedAtMs&&executionAtMs>=acceptedAtMs&&executionAtMs<cutoffMs+UPDATE_GRACE_MS;
}

// A backing is a lot of principal at an entry listener count. Its fraction is
// fixed at order time; queued exits never promise an order-time Credit payout.
export interface BackingLot {
  principalCents: bigint;
  entryListeners: bigint;
  remainingQuanta: bigint;
  proceedsRemainder: bigint;
}
function validateLot(lot: BackingLot){
  integer(lot.principalCents,MIN_BACKING_CENTS,MAX_CENTS,'lot principal');
  integer(lot.entryListeners,1n,MAX_LISTENERS,'entry listener count');
  integer(lot.remainingQuanta,0n,LOT_QUANTA,'remaining lot fraction');
  integer(lot.proceedsRemainder,0n,LOT_QUANTA*lot.entryListeners-1n,'proceeds remainder');
  if(lot.remainingQuanta===0n&&lot.proceedsRemainder!==0n)throw new RangeError('A closed lot cannot retain payable remainder');
}
export function createBackingLot(principalCents: bigint,entryListeners: bigint): BackingLot {
  const lot={principalCents,entryListeners,remainingQuanta:LOT_QUANTA,proceedsRemainder:0n};
  validateLot(lot);return lot;
}
export function exitQuanta(availableQuanta: bigint,basisPoints: number){
  integer(availableQuanta,0n,LOT_QUANTA,'available lot fraction');
  if(!Number.isInteger(basisPoints)||basisPoints<1||basisPoints>10_000)throw new RangeError('Exit must be 0.01% to 100%');
  return availableQuanta*BigInt(basisPoints)/10_000n;
}
export function lotValueCents(lot: BackingLot,listeners: bigint){
  validateLot(lot);integer(listeners,1n,MAX_LISTENERS,'listener count');
  const value=(lot.principalCents*lot.remainingQuanta*listeners+lot.proceedsRemainder)/(LOT_QUANTA*lot.entryListeners);
  integer(value,0n,MAX_CENTS,'lot value');return value;
}
export function executeLotExit(lot: BackingLot,quanta: bigint,listeners: bigint){
  validateLot(lot);integer(listeners,1n,MAX_LISTENERS,'listener count');
  integer(quanta,1n,lot.remainingQuanta,'exit fraction');
  const denominator=LOT_QUANTA*lot.entryListeners;
  const numerator=lot.principalCents*quanta*listeners+lot.proceedsRemainder;
  const creditedCents=numerator/denominator,remainder=numerator%denominator;
  integer(creditedCents,0n,MAX_CENTS,'exit proceeds');
  const remainingQuanta=lot.remainingQuanta-quanta;
  return {
    creditedCents,
    lot:{...lot,remainingQuanta,proceedsRemainder:remainingQuanta===0n?0n:remainder},
    retiredRemainder:remainingQuanta===0n?remainder:0n,
    remainderDenominator:denominator,
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {INITIAL_CREDITS_CENTS,LOT_QUANTA,MAX_CENTS,UPDATE_GRACE_MS,UPDATE_INTERVAL_MS,parseCreditCents,validateBackingAmount,nextUpdateCutoff,baselineIsFresh,snapshotCanExecute,createBackingLot,exitQuanta,lotValueCents,executeLotExit} from '../src/domain/backing-policy.ts';

test('Credit inputs are exact cents, reject exponent/fractional precision and respect the available balance',()=>{
  assert.equal(INITIAL_CREDITS_CENTS,100000n);
  assert.equal(parseCreditCents('250.01'),25001n);
  assert.equal(parseCreditCents('92233720368547758.07'),MAX_CENTS);
  for(const input of ['-1','NaN','Infinity','1e3','0.001',' 10','92233720368547758.08'])assert.throws(()=>parseCreditCents(input));
  validateBackingAmount(25000n,100000n);
  assert.throws(()=>validateBackingAmount(99n,100000n));
  assert.throws(()=>validateBackingAmount(100001n,100000n));
});
test('order boundaries are strict at 00:00 and 12:00 UTC and independent of DST',()=>{
  const t=Date.parse('2026-11-12T12:00:00Z');
  assert.equal(nextUpdateCutoff(t-1),t);
  assert.equal(nextUpdateCutoff(t),t+UPDATE_INTERVAL_MS);
  assert.equal(nextUpdateCutoff(Date.parse('2026-03-08T00:00:00Z')),Date.parse('2026-03-08T12:00:00Z'));
  assert.throws(()=>nextUpdateCutoff(NaN));
});
test('failed slots carry forward, while old, late, suspended and already superseded batches cannot execute',()=>{
  const cutoff=Date.parse('2026-11-12T12:00:00Z');
  const input={orderAcceptedAtMs:cutoff-1000,cutoffMs:cutoff,observedAtMs:cutoff+1000,acceptedAtMs:cutoff+2000,executionAtMs:cutoff+3000,lastSettledCutoffMs:cutoff-UPDATE_INTERVAL_MS,valid:true,artistActive:true};
  assert.equal(snapshotCanExecute(input),true);
  for(const patch of [{valid:false},{artistActive:false},{orderAcceptedAtMs:cutoff},{observedAtMs:cutoff-1},{executionAtMs:cutoff+UPDATE_GRACE_MS},{lastSettledCutoffMs:cutoff}])assert.equal(snapshotCanExecute({...input,...patch}),false);
  const next=cutoff+UPDATE_INTERVAL_MS;
  assert.equal(snapshotCanExecute({...input,cutoffMs:next,observedAtMs:next,acceptedAtMs:next+1,executionAtMs:next+2}),true);
  assert.equal(baselineIsFresh(cutoff-24*60*60*1000,cutoff),true);
  assert.equal(baselineIsFresh(cutoff-24*60*60*1000-1,cutoff),false);
  assert.equal(baselineIsFresh(cutoff+1,cutoff),false);
});
test('250 Credits follow listener growth and losses without approximating an entry share price',()=>{
  const lot=createBackingLot(25000n,100000n);
  assert.equal(lotValueCents(lot,100000n),25000n);
  assert.equal(lotValueCents(lot,200000n),50000n);
  assert.equal(lotValueCents(lot,60000n),15000n);
  assert.equal(executeLotExit(lot,LOT_QUANTA,100000n).creditedCents,25000n);
  assert.throws(()=>createBackingLot(25000n,0n));
  assert.throws(()=>lotValueCents(lot,0n));
});
test('partial exits fix a fraction, preserve principal/entry evidence and cannot oversell',()=>{
  const lot=createBackingLot(25000n,100000n);
  const half=exitQuanta(LOT_QUANTA,5000);
  const first=executeLotExit(lot,half,120000n);
  assert.equal(first.creditedCents,15000n);
  assert.equal(first.lot.remainingQuanta,LOT_QUANTA/2n);
  assert.equal(first.lot.principalCents,lot.principalCents);
  assert.equal(first.lot.entryListeners,lot.entryListeners);
  assert.equal(lot.remainingQuanta,LOT_QUANTA,'input lot is immutable');
  assert.throws(()=>executeLotExit(first.lot,LOT_QUANTA,120000n));
  assert.equal(exitQuanta(first.lot.remainingQuanta,10000),first.lot.remainingQuanta);
});
test('an odd-cent principal is conserved across partial exits at an unchanged listener count',()=>{
  const lot=createBackingLot(101n,1000n);
  const first=executeLotExit(lot,LOT_QUANTA/2n,1000n);
  assert.equal(first.creditedCents,50n);
  assert.equal(lotValueCents(first.lot,1000n),51n,'unpaid subcent proceeds stay attached to the remaining lot');
  const last=executeLotExit(first.lot,first.lot.remainingQuanta,1000n);
  assert.equal(last.creditedCents,51n);
  assert.equal(first.creditedCents+last.creditedCents,101n);
  assert.equal(last.lot.proceedsRemainder,0n);
});
test('rounding carry conserves the floor of exact lifetime proceeds across changing exit prices',()=>{
  let lot=createBackingLot(10001n,1009n),credited=0n,numerator=0n;
  const principal=lot.principalCents,denominator=LOT_QUANTA*lot.entryListeners;
  for(const listeners of [899n,1301n,701n,2003n]){
    const quanta=listeners===2003n?lot.remainingQuanta:LOT_QUANTA/4n;
    numerator+=principal*quanta*listeners;
    const result=executeLotExit(lot,quanta,listeners);credited+=result.creditedCents;lot=result.lot;
    assert.ok(result.retiredRemainder<denominator);
  }
  assert.equal(credited,numerator/denominator);
  assert.equal(lot.remainingQuanta,0n);
  assert.throws(()=>executeLotExit(lot,1n,1000n));
});
test('overflow and invalid percentage/fraction values fail explicitly rather than capping a return',()=>{
  const lot=createBackingLot(MAX_CENTS,1n);
  assert.throws(()=>lotValueCents(lot,2n));
  assert.throws(()=>executeLotExit(lot,LOT_QUANTA,2n));
  for(const p of [0,10001,50.5,NaN])assert.throws(()=>exitQuanta(LOT_QUANTA,p));
  assert.throws(()=>exitQuanta(LOT_QUANTA+1n,5000));
});

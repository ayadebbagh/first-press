import test from 'node:test';
import assert from 'node:assert/strict';
import {artists} from '../src/catalog.ts';
import {listenersAt} from '../src/engine.ts';
import {HISTORY_DAY_MS,demoListenerHistory,historyWindow} from '../src/lib/listener-history.ts';
const at=Date.parse('2026-11-12T12:00:00Z');
const history=points=>({kind:'verified',metric:'monthly_listeners',points,asOf:at,expectedIntervalMs:HISTORY_DAY_MS/2});

test('demo curves are explicitly synthetic, artist-specific and end at the current demo count',()=>{
  for(const artist of artists){
    const initial=demoListenerHistory(artist,0),updated=demoListenerHistory(artist,2);
    assert.equal(initial.kind,'demo');
    assert.equal(initial.points.at(-1).value,artist.listeners);
    assert.equal(updated.points.at(-1).value,listenersAt(artist,2));
    assert.deepEqual(updated.points.slice(0,91),initial.points,'new demo observations append rather than changing prior samples');
    const window=historyWindow(initial,7);
    assert.equal(Math.sign(window.change),Math.sign(artist.change));
  }
  assert.notDeepEqual(demoListenerHistory(artists[0],0).points,demoListenerHistory(artists[1],0).points);
});
test('a period filters actual timestamps without padding missing observations or extrapolating',()=>{
  const source=history([{at:at-20*HISTORY_DAY_MS,value:100},{at:at-3*HISTORY_DAY_MS,value:120},{at:at-HISTORY_DAY_MS,value:90}]);
  const selected=historyWindow(source,7);
  assert.equal(selected.points.length,2);
  assert.equal(selected.points.at(-1).at,at-HISTORY_DAY_MS);
  assert.equal(selected.change,-25);
  assert.equal(historyWindow(source,30).points.length,3);
  assert.deepEqual(source.points.map(p=>p.value),[100,120,90]);
});
test('outages create separate line segments and never become a zero audience',()=>{
  const source=history([{at:at-2*HISTORY_DAY_MS,value:100},{at:at-1.5*HISTORY_DAY_MS,value:110},{at,value:90}]);
  const view=historyWindow(source,7);
  assert.deepEqual(view.segments.map(s=>s.length),[2,1]);
  assert.deepEqual(view.points.map(p=>p.value),[100,110,90]);
});
test('empty, single-point and flat histories have safe scales and no invented growth',()=>{
  const empty=historyWindow(history([]),7);assert.equal(empty.points.length,0);assert.equal(empty.change,null);assert.ok(empty.max>empty.min);
  const one=historyWindow(history([{at,value:100}]),7);assert.equal(one.points.length,1);assert.equal(one.change,null);assert.ok(one.max>one.min);
  const flat=historyWindow(history([{at:at-HISTORY_DAY_MS/2,value:100},{at,value:100}]),7);assert.equal(flat.change,0);assert.ok(flat.max>flat.min);
});
test('invalid, future and conflicting duplicate readings are not converted into valid data',()=>{
  const source=history([{at,value:100},{at,value:200},{at:at-1000,value:90},{at:at-2000,value:NaN},{at:at+1,value:300},{at:at-3000,value:-1}]);
  assert.deepEqual(historyWindow(source,7).points,[{at:at-1000,value:90}]);
});

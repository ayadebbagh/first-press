import test from 'node:test';
import assert from 'node:assert/strict';
import {artists} from '../src/catalog.ts';
import {getDailyTrack,getPlayback} from '../src/playback.ts';
import {initialState,queueOrder,cancelOrder,advanceSnapshot,reservedCredits,reservedUnits,portfolioValue,priceAt,listenersAt,loadState} from '../src/engine.ts';
const artistId='artist_001',at='2026-11-08T13:00:00Z',later='2026-11-08T18:00:00Z';
const buy=(s,amount=100,id='order-1')=>queueOrder(s,{artistId,side:'buy',amount},id,at);
const near=(a,b)=>assert.ok(Math.abs(a-b)<.011,`${a} should equal ${b}`);

test('catalog contains 50 unique artists and 100 unique discovery tracks',()=>{
 assert.equal(artists.length,50);assert.equal(new Set(artists.map(a=>a.id)).size,50);
 const tracks=artists.flatMap(a=>a.tracks);assert.equal(tracks.length,100);assert.equal(new Set(tracks.map(t=>t.id)).size,100);
 assert.ok(artists.every(a=>a.listeners>0));
});
test('every daily pick has a confirmed player; local artwork exists',async()=>{
 const {access}=await import('node:fs/promises');
 for(const a of artists.slice(0,8))assert.equal(getPlayback(getDailyTrack(a)).provider,'spotify',a.name+' needs a daily sound check');
 for(const a of artists.filter(a=>a.image?.startsWith('assets/')))await access(new URL('../public/'+a.image,import.meta.url));
});
test('queued buy reserves cash without creating a holding or receipt',()=>{
 const initial=initialState(),s=buy(initial,250);
 assert.equal(s.credits,750);assert.equal(reservedCredits(s),250);assert.equal(portfolioValue(s),0);
 assert.equal(s.receipts.length,0);assert.deepEqual(s.holdings,{});assert.equal(initial.credits,1000);
});
test('reserved cash cannot be spent twice; invalid order values are rejected',()=>{
 const s=buy(initialState(),800);
 for(const amount of [201,-1,0,NaN,Infinity,1.234])assert.throws(()=>buy(s,amount,'another'));
 assert.throws(()=>queueOrder(s,{artistId:'missing',side:'buy',amount:1},'id',at));
 assert.throws(()=>queueOrder(s,{artistId,side:'short',amount:1},'id',at));
 assert.equal(s.credits,200);
});
test('canceling releases the exact reservation once',()=>{
 const s=buy(initialState(),333.33);const canceled=cancelOrder(s,'order-1');
 assert.equal(canceled.credits,1000);assert.equal(canceled.orders.length,0);
 assert.equal(cancelOrder(canceled,'order-1').credits,1000);
});
test('buy settles at NEXT update price and receipt captures execution time and listeners',()=>{
 const s=advanceSnapshot(buy(initialState(),250),later),a=artists[0],r=s.receipts[0];
 assert.equal(s.snapshot,1);assert.equal(s.orders.length,0);assert.equal(s.credits,750);
 near(portfolioValue(s),250);near(s.holdings[artistId].units,250/priceAt(a,1));
 assert.equal(r.createdAt,later);assert.equal(r.listeners,listenersAt(a,1));assert.equal(r.snapshot,1);assert.equal(r.credits,250);
 assert.notEqual(r.entryPrice,priceAt(a,0));
});
test('holding value moves proportionally with listeners, including losses',()=>{
 let s=advanceSnapshot(buy(initialState(),500),later);const a=artists[0],entry=s.receipts[0].listeners;
 s=advanceSnapshot(s,later);near(portfolioValue(s),500*listenersAt(a,2)/entry);
 const before=portfolioValue(s);s=advanceSnapshot(s,later);assert.ok(portfolioValue(s)<before);
});
test('queued sells reserve units and block overselling',()=>{
 let s=advanceSnapshot(buy(initialState(),400),later),units=s.holdings[artistId].units;
 s=queueOrder(s,{artistId,side:'sell',amount:units*.75},'sell',at);
 near(reservedUnits(s,artistId),units*.75);assert.equal(s.credits,600);
 assert.throws(()=>queueOrder(s,{artistId,side:'sell',amount:units*.5},'over',at));
 assert.throws(()=>queueOrder(initialState(),{artistId,side:'sell',amount:1},'unheld',at));
 near(reservedUnits(cancelOrder(s,'sell'),artistId),0);
});
test('partial sale releases proceeds at settlement and reduces cost basis proportionally',()=>{
 let s=advanceSnapshot(buy(initialState(),400),later),units=s.holdings[artistId].units;
 s=queueOrder(s,{artistId,side:'sell',amount:units/2},'sell',at);s=advanceSnapshot(s,later);
 near(s.credits,600+(units/2)*priceAt(artists[0],2));near(s.holdings[artistId].units,units/2);
 assert.equal(s.holdings[artistId].cost,200);assert.equal(s.receipts.length,1);
});
test('selling all closes the position but preserves original receipt unchanged',()=>{
 let s=advanceSnapshot(buy(initialState(),1000),later),receipt=structuredClone(s.receipts[0]);
 s=queueOrder(s,{artistId,side:'sell',amount:s.holdings[artistId].units},'sell',at);
 s=advanceSnapshot(s,later);assert.equal(s.holdings[artistId],undefined);assert.equal(s.orders.length,0);
 assert.ok(s.credits>1000);assert.deepEqual(s.receipts[0],receipt);
});
test('multi-artist batch retains wallet accounting and duplicate updates do not execute orders twice',()=>{
 let s=initialState();
 for(let i=0;i<10;i++)s=queueOrder(s,{artistId:artists[i].id,side:'buy',amount:100},`buy${i}`,at);
 assert.equal(s.credits,0);assert.equal(reservedCredits(s),1000);s=advanceSnapshot(s,later);
 near(portfolioValue(s),1000);assert.equal(s.receipts.length,10);assert.equal(Object.keys(s.holdings).length,10);
 s=advanceSnapshot(s,later);assert.equal(s.receipts.length,10);assert.equal(s.credits,0);
});
test('persistence round-trip retains orders and receipts and recovers from invalid JSON/version',()=>{
 const s=buy(advanceSnapshot(buy(initialState(),100),later),50,'order-2');
 assert.deepEqual(loadState(JSON.stringify(s)),s);
 for(const raw of [null,'bad json','{}','{"version":2}','{"version":1,"credits":-1}'])assert.deepEqual(loadState(raw),initialState());
});

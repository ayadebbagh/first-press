import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../src/engine.ts';
import {dailyArtists,getDaily,moveRank,vote} from '../src/lib/daily.ts';
const today='2026-11-08';
function finish(){let state=initialState();for(let i=0;i<4;i++)state=vote(state,dailyArtists[i*2].id,today);return state;}
test('only the current matchup can be voted on and four calls is the limit',()=>{
 const start=initialState();assert.equal(vote(start,dailyArtists[7].id,today),start);
 const state=finish();assert.equal(state.daily.votes.length,4);
 assert.equal(vote(state,dailyArtists[0].id,today),state);assert.equal(start.daily.votes.length,0);
});
test('ranking preserves all eight picks and locks after reveal',()=>{
 const before=finish(),after=moveRank(before,0,1,today);
 assert.equal(after.daily.guess[1],before.daily.guess[0]);assert.deepEqual(new Set(after.daily.guess),new Set(dailyArtists.map(a=>a.id)));
 assert.equal(moveRank(after,0,-1,today),after);
 const revealed={...after,daily:{...after.daily,revealed:true}};assert.equal(moveRank(revealed,0,1,today),revealed);
 assert.equal(moveRank(initialState(),0,1,today).daily.votes.length,0);
});
test('a new UTC day resets daily activity while preserving portfolio data',()=>{
 const state={...finish(),credits:750};const next=getDaily(state,'2026-11-09');
 assert.equal(next.day,'2026-11-09');assert.deepEqual(next.votes,[]);assert.equal(next.revealed,false);assert.equal(state.credits,750);assert.equal(state.daily.votes.length,4);
});

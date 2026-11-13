import {test} from 'node:test';
import assert from 'node:assert/strict';
import {observationEnvelope,validateListenerObservation} from '../src/domain/listener-validation.ts';
const now=new Date('2026-11-12T12:00:00.000Z'),artist={spotifyArtistId:'1111111111111111111111',status:'active',synthetic:false};
const input=()=>({artistId:'artist',sourceEventKey:'capture-1',provider:'spotify',metric:'monthly_listeners',providerArtistId:artist.spotifyArtistId,
  listenerCount:'10000',sourceUrl:'https://open.spotify.com/artist/'+artist.spotifyArtistId,evidence:{reference:'evidence/capture-1.png',sha256:'a'.repeat(64)},parserVersion:'manual-v1',observedAt:'2026-11-12T11:59:00.000Z',fetchedAt:'2026-11-12T11:59:01.000Z',sourceUpdatedAt:null});
const context=()=>({now,artist,disputed:false});
const check=(patch={},extra={})=>validateListenerObservation({...input(),...patch},{...context(),...extra});

test('valid exact counts retain distinct observation, fetch and unknown platform update times',()=>{
  const result=check();assert.equal(result.status,'accepted');assert.equal(result.listenerCount,10000n);assert.equal(result.sourceUpdatedAt,null);
  assert.notEqual(result.observedAt.getTime(),result.fetchedAt.getTime());
  for(const value of [1,'1',1000000000000,'1000000000000'])assert.equal(check({listenerCount:value}).status,'accepted');
});
test('missing, zero, malformed, abbreviated and out-of-range counts never become zero quotes',()=>{
  for(const listenerCount of [undefined,null,'',0,'0',-1,'-1',1.5,'1.5','1e4','10K','10,000','010',{},true,'1000000000001',Number.MAX_SAFE_INTEGER]){
    const result=check({listenerCount});assert.equal(result.status,'quarantined');assert.equal(result.listenerCount,null);assert.ok(result.reasons.includes('invalid_listener_count'));
  }
});
test('provider, metric, profile URL and canonical artist mismatches require review',()=>{
  for(const patch of [{provider:'soundcloud'},{metric:'streams'},{metric:'followers'},{providerArtistId:'2222222222222222222222'},{sourceUrl:'https://open.spotify.com/artist/2222222222222222222222'},{sourceUrl:'https://open.spotify.com.attacker.invalid/artist/'+artist.spotifyArtistId}])assert.equal(check(patch).status,'quarantined');
});
test('malformed, stale, future and reversed instants are quarantined without inventing timestamps',()=>{
  for(const patch of [{observedAt:'yesterday'},{observedAt:'2026-02-31T11:59:00.000Z'},{observedAt:'2026-11-12T11:59:00'},{observedAt:'2026-11-11T11:59:59.999Z'},{observedAt:'2026-11-12T12:00:00.001Z'},{fetchedAt:'2026-11-12T11:58:00.000Z'},{fetchedAt:'2026-11-12T12:00:00.001Z'},{sourceUpdatedAt:'wrong'},{sourceUpdatedAt:'2026-11-12T12:00:00.000Z'},{sourceUpdatedAt:'2026-11-10T12:00:00.000Z'}])assert.equal(check(patch).status,'quarantined',JSON.stringify(patch));
  assert.equal(check({observedAt:'2026-11-11T12:00:00.000Z'}).status,'accepted');
});
test('new unchanged counts are valid; equal or earlier captures cannot displace newer observations',()=>{
  const previous={listenerCount:10000n,observedAt:new Date('2026-11-12T11:58:00.000Z')};
  assert.equal(check({}, {previous}).status,'accepted');
  for(const observedAt of ['2026-11-12T11:58:00.000Z','2026-11-12T11:57:00.000Z'])assert.ok(check({observedAt},{previous}).reasons.includes('out_of_order_observation'));
});
test('50 percent listener changes require explicit confirmation on a quarantined successor',()=>{
  const previous={listenerCount:10000n,observedAt:new Date('2026-11-12T11:58:00.000Z')};
  for(const listenerCount of ['5000','15000','1000000000000'])assert.ok(check({listenerCount},{previous}).reasons.includes('listener_change_requires_review'));
  assert.equal(check({listenerCount:'14999'},{previous}).status,'accepted');
  const correction={status:'quarantined',reasons:['listener_change_requires_review'],payload:{...input(),listenerCount:'20000'}};
  const reviewed={listenerCount:'20000',correctsObservationId:'quarantine',reviewReason:'Compared the archived artist profile and confirmed the count.'};
  assert.equal(check(reviewed,{previous,correction}).status,'accepted');
  assert.equal(check({...reviewed,metric:'followers'},{previous,correction}).status,'quarantined');
  assert.equal(check({...reviewed,reviewReason:'ok'},{previous,correction}).status,'quarantined');
  assert.equal(check({...reviewed,correctsObservationId:undefined},{previous}).status,'quarantined');
  for(const patch of [{listenerCount:'30000'},{observedAt:'2026-11-12T11:58:59.000Z'},{evidence:{reference:'different',sha256:'a'.repeat(64)}}])assert.ok(check({...reviewed,...patch},{previous,correction}).reasons.includes('outlier_review_capture_mismatch'));
  assert.ok(check(reviewed,{previous,correction:{...correction,payload:{...correction.payload,evidence:{...input().evidence,unexpected:'remove'}}}}).reasons.includes('outlier_review_capture_mismatch'));
});
test('accepted corrections and disputed history stay blocked for the incident process',()=>{
  assert.ok(check({correctsObservationId:'accepted'},{correction:{status:'accepted',reasons:[]}}).reasons.includes('accepted_correction_requires_incident_review'));
  assert.equal(check({}, {disputed:true}).status,'quarantined');
  for(const status of ['review','suspended','archived'])assert.equal(check({}, {artist:{...artist,status}}).status,'quarantined');
  assert.equal(check({}, {artist:{...artist,synthetic:true}}).status,'quarantined');
  assert.equal(check({correctsObservationId:'intermediary'},{correction:{status:'quarantined',reasons:['accepted_correction_requires_incident_review']}}).status,'quarantined');
  assert.equal(check({correctsObservationId:'descendant'},{correction:{status:'quarantined',reasons:[],incidentBlocked:true}}).status,'quarantined');
});
test('missing evidence and parser provenance cannot create accepted quotes',()=>{
  for(const patch of [{evidence:null},{evidence:{reference:'x',sha256:'invalid'}},{evidence:{reference:'',sha256:'a'.repeat(64)}},{parserVersion:''}])assert.equal(check(patch).status,'quarantined');
});
test('the envelope rejects client authority fields but preserves invalid readings for review',()=>{
  assert.equal(observationEnvelope({...input(),listenerCount:{bad:'raw'}}).listenerCount.bad,'raw');
  for(const patch of [{synthetic:false},{status:'accepted'},{acceptedAt:now.toISOString()},{actorId:'admin'},{artistId:''},{sourceEventKey:''},{correctsObservationId:4}])assert.throws(()=>observationEnvelope({...input(),...patch}));
});

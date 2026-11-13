import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import * as schema from '../../src/server/db/schema.ts';
import {ObservationError,submitListenerObservation} from '../../src/server/data/listener-observations.ts';
const url=process.env.TEST_OBSERVATION_DATABASE_URL;
if(!url||!new URL(url).pathname.endsWith('_test'))throw Error('Explicit disposable TEST_OBSERVATION_DATABASE_URL ending _test required.');
const pool=new pg.Pool({connectionString:url,max:16}),db=drizzle(pool,{schema});
before(()=>{const result=spawnSync(process.execPath,['scripts/db/migrate.mjs'],{env:{...process.env,DATABASE_URL:url},encoding:'utf8',timeout:60000});assert.equal(result.status,0,result.stdout+result.stderr);});
after(async()=>pool.end());
async function fixture({role='admin',verified=true,status='active',synthetic=false}={}){
  const actor=randomUUID(),artist=randomUUID(),email=actor+'@example.invalid',spotify=artist.replaceAll('-','').slice(0,22);
  await pool.query("INSERT INTO beta_invites(email,created_by,expires_at) VALUES ($1,'observation-fixture',now()+interval '1 day')",[email]);
  await pool.query('INSERT INTO "user"(id,name,email,email_verified) VALUES ($1,\'Observation Fixture\',$2,$3)',[actor,email,verified]);
  if(role==='admin')await pool.query("UPDATE members SET role='admin' WHERE user_id=$1",[actor]);
  await pool.query("INSERT INTO artists(id,slug,name,spotify_artist_id,status,synthetic) VALUES ($1,$1,'Observation Fixture',$2,$3,$4)",[artist,spotify,status,synthetic]);
  const now=Date.now();
  const input={artistId:artist,sourceEventKey:randomUUID(),provider:'spotify',metric:'monthly_listeners',providerArtistId:spotify,listenerCount:'10000',sourceUrl:'https://open.spotify.com/artist/'+spotify,
    evidence:{reference:'fixture/'+artist+'.png',sha256:'a'.repeat(64)},parserVersion:'manual-fixture-v1',observedAt:new Date(now-600000).toISOString(),fetchedAt:new Date(now-599000).toISOString(),sourceUpdatedAt:null};
  return {actor,artist,input,submit:patch=>submitListenerObservation(db,actor,{...input,...patch})};
}
const error=code=>e=>e instanceof ObservationError&&e.code===code;
const snapshot=async id=>(await pool.query('SELECT * FROM listener_snapshots WHERE id=$1',[id])).rows[0];

test('concurrent capture retries admit one immutable snapshot and canonical payload hash',async()=>{
  const f=await fixture(),results=await Promise.all(Array.from({length:12},()=>f.submit()));
  assert.equal(results.filter(x=>x.created).length,1);assert.equal(new Set(results.map(x=>x.id)).size,1);assert.ok(results.every(x=>x.status==='accepted'));
  const quote=await snapshot(results[0].snapshotId);assert.equal(quote.listener_count,'10000');assert.equal(quote.reviewed_by,f.actor);assert.equal(quote.source_updated_at,null);
  assert.equal(quote.observed_at.toISOString(),f.input.observedAt);assert.equal(quote.fetched_at.toISOString(),f.input.fetchedAt);assert.equal(quote.accepted_at.toISOString(),results[0].receivedAt);
  const reversed=Object.fromEntries(Object.entries(f.input).reverse());assert.equal((await submitListenerObservation(db,f.actor,reversed)).id,results[0].id);
  for(const patch of [{listenerCount:'10001'},{observedAt:new Date().toISOString()},{evidence:{reference:'different',sha256:'b'.repeat(64)}}])await assert.rejects(f.submit(patch),error('conflict'));
});
test('invalid counts and provider/timestamp failures preserve original input without a pricing snapshot',async()=>{
  const f=await fixture();
  for(const patch of [{listenerCount:null},{listenerCount:'bad'},{listenerCount:0},{listenerCount:'1000000000001'},{metric:'streams'},{metric:'followers'},{provider:'soundcloud'},{providerArtistId:'wrong'},{observedAt:'not-a-time'},{observedAt:new Date(Date.now()-90000000).toISOString()},{fetchedAt:new Date(Date.now()+60000).toISOString()}]){
    const result=await f.submit({...patch,sourceEventKey:randomUUID()});assert.equal(result.status,'quarantined');assert.equal(result.snapshotId,null);assert.ok(result.reasons.length);
    const raw=(await pool.query('SELECT payload FROM listener_observations WHERE id=$1',[result.id])).rows[0].payload;
    for(const [key,value] of Object.entries(patch))assert.deepEqual(raw[key],value);
  }
  assert.equal((await pool.query('SELECT count(*)::int n FROM listener_snapshots WHERE artist_id=$1',[f.artist])).rows[0].n,0);
});
test('fresh unchanged captures are accepted and old or equal captures never replace newer history',async()=>{
  const f=await fixture(),first=await f.submit();
  const second=await f.submit({sourceEventKey:randomUUID(),observedAt:new Date(Date.now()-120000).toISOString(),fetchedAt:new Date(Date.now()-119000).toISOString()});
  assert.equal(second.status,'accepted');assert.notEqual(first.snapshotId,second.snapshotId);
  const old=await f.submit({sourceEventKey:randomUUID()});assert.equal(old.status,'quarantined');assert.ok(old.reasons.includes('out_of_order_observation'));
});
test('competing capture arrivals serialize against the newest accepted observation',async()=>{
  const f=await fixture();await f.submit();
  const results=await Promise.all([120000,60000].map((age,i)=>f.submit({sourceEventKey:randomUUID(),listenerCount:String(10100+i*100),observedAt:new Date(Date.now()-age).toISOString(),fetchedAt:new Date(Date.now()-age+1000).toISOString()})));
  assert.equal(results[1].status,'accepted');
  const latest=(await pool.query("SELECT listener_count FROM listener_snapshots WHERE artist_id=$1 AND status='accepted' ORDER BY observed_at DESC LIMIT 1",[f.artist])).rows[0];assert.equal(latest.listener_count,'10200');
});
test('outlier review appends a linked successor; a reason alone cannot bypass it',async()=>{
  const f=await fixture();await f.submit();
  const capture={sourceEventKey:randomUUID(),listenerCount:'20000',observedAt:new Date(Date.now()-120000).toISOString(),fetchedAt:new Date(Date.now()-119000).toISOString()};
  const outlier=await f.submit(capture);assert.equal(outlier.status,'quarantined');assert.ok(outlier.reasons.includes('listener_change_requires_review'));
  const noParent=await f.submit({...capture,sourceEventKey:randomUUID(),reviewReason:'Compared archived evidence and confirmed the listener count.'});assert.equal(noParent.status,'quarantined');
  const confirmed=await f.submit({...capture,sourceEventKey:randomUUID(),correctsObservationId:outlier.id,reviewReason:'Compared archived evidence and confirmed the listener count.'});
  assert.equal(confirmed.status,'accepted');assert.equal(confirmed.correctsObservationId,outlier.id);
  assert.equal((await pool.query('SELECT status FROM listener_observations WHERE id=$1',[outlier.id])).rows[0].status,'quarantined');
});
test('a corrected malformed reading can be accepted without mutating its quarantined parent',async()=>{
  const f=await fixture(),original=await f.submit({listenerCount:'10K'});
  const corrected=await f.submit({sourceEventKey:randomUUID(),correctsObservationId:original.id,reviewReason:'Transcribed the full integer from the archived evidence.'});
  assert.equal(corrected.status,'accepted');assert.equal((await snapshot(corrected.snapshotId)).listener_count,'10000');
  const parent=(await pool.query('SELECT payload,status FROM listener_observations WHERE id=$1',[original.id])).rows[0];assert.equal(parent.payload.listenerCount,'10K');assert.equal(parent.status,'quarantined');
  const other=await fixture();await assert.rejects(other.submit({correctsObservationId:original.id}),error('not_found'));
});
test('accepted-source corrections and disputes cannot silently reprice history',async()=>{
  const f=await fixture(),original=await f.submit();
  const corrected=await f.submit({sourceEventKey:randomUUID(),correctsObservationId:original.id,listenerCount:'11000',observedAt:new Date(Date.now()-120000).toISOString(),fetchedAt:new Date(Date.now()-119000).toISOString()});
  assert.equal(corrected.status,'quarantined');assert.ok(corrected.reasons.includes('accepted_correction_requires_incident_review'));
  let parent=corrected.id;
  for(let i=0;i<4;i++){
    const descendant=await f.submit({sourceEventKey:randomUUID(),correctsObservationId:parent,listenerCount:'11000',observedAt:new Date(Date.now()-110000+i*1000).toISOString(),fetchedAt:new Date(Date.now()-109000+i*1000).toISOString()});
    assert.equal(descendant.status,'quarantined');assert.equal(descendant.snapshotId,null);assert.ok(descendant.reasons.includes('accepted_correction_requires_incident_review'));parent=descendant.id;
  }
  await pool.query("INSERT INTO snapshot_annotations(id,snapshot_id,kind,reason,actor_id) VALUES ($1,$2,'disputed','Fixture incident',$3)",[randomUUID(),original.snapshotId,f.actor]);
  const disputed=await f.submit({sourceEventKey:randomUUID(),observedAt:new Date(Date.now()-60000).toISOString(),fetchedAt:new Date(Date.now()-59000).toISOString()});
  assert.equal(disputed.status,'quarantined');assert.ok(disputed.reasons.includes('disputed_history_requires_incident_review'));assert.equal((await snapshot(original.snapshotId)).listener_count,'10000');
});
test('outlier confirmations cannot reuse a quarantine for different count, time or evidence',async()=>{
  const f=await fixture();await f.submit();
  const candidate={sourceEventKey:randomUUID(),listenerCount:'20000',observedAt:new Date(Date.now()-120000).toISOString(),fetchedAt:new Date(Date.now()-119000).toISOString()};
  const quarantined=await f.submit(candidate);assert.equal(quarantined.status,'quarantined');
  for(const patch of [{listenerCount:'1000000000000'},{observedAt:new Date(Date.now()-100000).toISOString(),fetchedAt:new Date(Date.now()-99000).toISOString()},{evidence:{reference:'different.png',sha256:'b'.repeat(64)}}]){
    const result=await f.submit({...candidate,...patch,sourceEventKey:randomUUID(),correctsObservationId:quarantined.id,reviewReason:'Explicitly reviewed the archived source count and evidence.'});
    assert.equal(result.status,'quarantined');assert.equal(result.snapshotId,null);assert.ok(result.reasons.includes('outlier_review_capture_mismatch'));
  }
  const confirmed=await f.submit({...candidate,sourceEventKey:randomUUID(),correctsObservationId:quarantined.id,reviewReason:'Explicitly reviewed this exact archived source count and evidence.'});assert.equal(confirmed.status,'accepted');
  const reused=await f.submit({...candidate,sourceEventKey:randomUUID(),correctsObservationId:quarantined.id,reviewReason:'Attempted to reuse the old confirmation for the same capture.'});assert.equal(reused.status,'quarantined');assert.ok(reused.reasons.includes('out_of_order_observation'));
});
test('correcting malformed parent evidence retains a deliberate candidate quarantine instead of a SQL error',async()=>{
  const f=await fixture();await f.submit();
  const candidate={sourceEventKey:randomUUID(),listenerCount:'20000',observedAt:new Date(Date.now()-120000).toISOString(),fetchedAt:new Date(Date.now()-119000).toISOString()};
  const bad=await f.submit({...candidate,evidence:{...f.input.evidence,unexpected:'remove'}});assert.equal(bad.status,'quarantined');assert.ok(bad.reasons.includes('invalid_evidence'));
  const corrected=await f.submit({...candidate,sourceEventKey:randomUUID(),correctsObservationId:bad.id,reviewReason:'Removed unsupported metadata and reviewed the archived evidence.'});
  assert.equal(corrected.status,'quarantined');assert.ok(corrected.reasons.includes('outlier_review_capture_mismatch'));
  const confirmed=await f.submit({...candidate,sourceEventKey:randomUUID(),correctsObservationId:corrected.id,reviewReason:'Confirmed this corrected candidate against the exact evidence.'});assert.equal(confirmed.status,'accepted');
});
test('PostgreSQL-incompatible Unicode is a deliberate envelope error, not a transient database failure',async()=>{
  const f=await fixture();
  for(const patch of [{listenerCount:'bad\u0000count'},{listenerCount:'bad\ud800count'},{listenerCount:'bad\udc00count'},{evidence:{reference:'bad\u0000reference',sha256:'a'.repeat(64)}},{sourceEventKey:'bad\u0000key'}])await assert.rejects(f.submit(patch),error('invalid'));
  const valid=await f.submit({evidence:{reference:'fixtures/é-音楽-🎵.png',sha256:'a'.repeat(64)}});assert.equal(valid.status,'accepted');
});
test('database guards independently reject laundering and mismatched outlier confirmations',async()=>{
  const f=await fixture(),accepted=await f.submit();
  const candidate={...f.input,listenerCount:'20000',sourceEventKey:randomUUID(),observedAt:new Date(Date.now()-120000).toISOString(),fetchedAt:new Date(Date.now()-119000).toISOString()};
  const outlier=await f.submit(candidate),incident=await f.submit({...candidate,listenerCount:'11000',sourceEventKey:randomUUID(),correctsObservationId:accepted.id});
  for(const [parent,payload,reason] of [[incident.id,{...candidate,listenerCount:'11000'},'ancestry'],[outlier.id,{...candidate,listenerCount:'30000'},'candidate']]){
    const client=await pool.connect(),id=randomUUID(),quote=randomUUID(),now=new Date();
    await client.query('BEGIN');
    try{
      const evidence={...payload.evidence,observationId:id,validationVersion:'spotify-listeners-v2'};
      await client.query(`INSERT INTO listener_snapshots(id,artist_id,status,listener_count,source_url,source_event_key,evidence,parser_version,observed_at,fetched_at,accepted_at,reviewed_by)
        VALUES ($1,$2,'accepted',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[quote,f.artist,payload.listenerCount,payload.sourceUrl,'observation:'+id,evidence,payload.parserVersion,payload.observedAt,payload.fetchedAt,now,f.actor]);
      await assert.rejects(client.query(`INSERT INTO listener_observations(id,artist_id,source_event_key,payload_hash,payload,status,reasons,validation_version,snapshot_id,corrects_observation_id,actor_id,received_at)
        VALUES ($1,$2,$1,repeat('a',64),$3,'accepted','[]','spotify-listeners-v2',$4,$5,$6,$7)`,[id,f.artist,payload,quote,parent,f.actor,now]),e=>e.code==='23514'&&e.message.includes(reason));
    }finally{await client.query('ROLLBACK');client.release();}
    assert.equal(await snapshot(quote),undefined);
  }
  // Bulk import cannot hide a just-inserted intermediary from ancestry checks.
  const client=await pool.connect(),parent=randomUUID(),id=randomUUID(),quote=randomUUID(),now=new Date();
  const payload={...candidate,listenerCount:'11000',correctsObservationId:parent};
  await client.query('BEGIN');
  try{
    await client.query(`INSERT INTO listener_snapshots(id,artist_id,status,listener_count,source_url,source_event_key,evidence,parser_version,observed_at,fetched_at,accepted_at,reviewed_by)
      VALUES ($1,$2,'accepted',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[quote,f.artist,payload.listenerCount,payload.sourceUrl,'observation:'+id,{...payload.evidence,observationId:id,validationVersion:'spotify-listeners-v2'},payload.parserVersion,payload.observedAt,payload.fetchedAt,now,f.actor]);
    await assert.rejects(client.query(`INSERT INTO listener_observations(id,artist_id,source_event_key,payload_hash,payload,status,reasons,validation_version,snapshot_id,corrects_observation_id,actor_id,received_at) VALUES
      ($1,$3,$1,repeat('a',64),'{}','quarantined','["accepted_correction_requires_incident_review"]','spotify-listeners-v2',NULL,$4,$5,$6),
      ($2,$3,$2,repeat('b',64),$7,'accepted','[]','spotify-listeners-v2',$8,$1,$5,$6)`,[parent,id,f.artist,accepted.id,f.actor,now,payload,quote]),e=>e.code==='23514'&&e.message.includes('ancestry'));
  }finally{await client.query('ROLLBACK');client.release();}
});
test('admission rejects non-admin/unverified/suspended callers and preserves the demo boundary',async()=>{
  for(const options of [{role:'member'},{verified:false}]){const f=await fixture(options);await assert.rejects(f.submit(),error('forbidden'));}
  const f=await fixture();await pool.query("UPDATE members SET status='suspended' WHERE user_id=$1",[f.actor]);await assert.rejects(f.submit(),error('forbidden'));
  for(const options of [{status:'review'},{status:'suspended'},{status:'archived'},{synthetic:true}]){const g=await fixture(options);assert.ok((await g.submit()).reasons.includes('artist_unavailable'));}
});
test('admin eligibility is rechecked after waiting for an artist admission lock',async()=>{
  const f=await fixture(),lock=await pool.connect();
  await lock.query('BEGIN');await lock.query('SELECT id FROM artists WHERE id=$1 FOR UPDATE',[f.artist]);
  const pending=f.submit();
  try{await pool.query("UPDATE members SET status='suspended' WHERE user_id=$1",[f.actor]);}
  finally{await lock.query('ROLLBACK');lock.release();}
  await assert.rejects(pending,error('forbidden'));
});
test('a separately classified demo database cannot admit backing observations',async()=>{
  const name='first_press_demo_guard_'+randomUUID().replaceAll('-','')+'_test',target=new URL(url);target.pathname='/'+name;
  await pool.query(`CREATE DATABASE "${name}"`);
  const other=new pg.Pool({connectionString:target.toString()});
  try{
    const result=spawnSync(process.execPath,['scripts/db/migrate.mjs'],{env:{...process.env,DATABASE_URL:target.toString()},encoding:'utf8',timeout:60000});assert.equal(result.status,0,result.stdout+result.stderr);
    await other.query("INSERT INTO beta_invites(email,created_by,expires_at) VALUES ('demo@example.invalid','fixture',now()+interval '1 day')");
    await other.query("INSERT INTO \"user\"(id,name,email,email_verified) VALUES ('demo-admin','Demo','demo@example.invalid',true)");
    await other.query("UPDATE members SET role='admin' WHERE user_id='demo-admin'");
    await other.query("INSERT INTO artists(id,slug,name,spotify_artist_id,status) VALUES ('artist','artist','Fixture','1111111111111111111111','active')");
    await other.query("INSERT INTO database_identity(purpose) VALUES ('demo')");
    await assert.rejects(submitListenerObservation(drizzle(other,{schema}),'demo-admin',{artistId:'artist',sourceEventKey:'demo-capture'}),error('unavailable'));
    assert.equal((await other.query('SELECT count(*)::int n FROM listener_observations')).rows[0].n,0);
  }finally{await other.end();await pool.query(`DROP DATABASE "${name}"`);}
});
test('raw and accepted evidence are append-only and quote mismatches fail at the database boundary',async()=>{
  const f=await fixture(),result=await f.submit();
  for(const table of ['listener_observations','listener_snapshots']){
    const id=table==='listener_observations'?result.id:result.snapshotId;
    await assert.rejects(pool.query(`UPDATE ${table} SET id=id WHERE id=$1`,[id]),e=>e.code==='23514');
    await assert.rejects(pool.query(`DELETE FROM ${table} WHERE id=$1`,[id]),e=>e.code==='23514');
  }
  await assert.rejects(pool.query(`INSERT INTO listener_observations(id,artist_id,source_event_key,payload_hash,payload,status,reasons,validation_version,snapshot_id,actor_id,received_at)
    SELECT $1,artist_id,$1,payload_hash,payload,'accepted','[]',validation_version,snapshot_id,actor_id,received_at FROM listener_observations WHERE id=$2`,[randomUUID(),result.id]),e=>e.code==='23514');
});
test('failed raw insertion rolls back its newly created quote atomically',async()=>{
  const f=await fixture();
  await pool.query(`CREATE FUNCTION fp_fail_observation_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source_event_key='rollback-fixture' THEN RAISE EXCEPTION 'fixture rejection'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER failure_fixture BEFORE INSERT ON listener_observations FOR EACH ROW EXECUTE FUNCTION fp_fail_observation_fixture()`);
  try{await assert.rejects(f.submit({sourceEventKey:'rollback-fixture'}));}
  finally{await pool.query('DROP TRIGGER failure_fixture ON listener_observations; DROP FUNCTION fp_fail_observation_fixture()');}
  for(const table of ['listener_observations','listener_snapshots'])assert.equal((await pool.query(`SELECT count(*)::int n FROM ${table} WHERE artist_id=$1`,[f.artist])).rows[0].n,0);
});
test('invalid envelopes, excessive nesting and oversized payloads fail without inserting history',async()=>{
  const f=await fixture();
  let nested={};for(let i=0;i<20;i++)nested={nested};
  for(const patch of [{status:'accepted'},{evidence:nested},{reviewReason:'x'.repeat(20000)},{sourceEventKey:''}])await assert.rejects(f.submit(patch),error('invalid'));
});

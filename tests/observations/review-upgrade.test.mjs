import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,symlink,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import * as schema from '../../src/server/db/schema.ts';
import {initializeWallet} from '../../src/server/backing/ledger.ts';
import {placeBuy,OrderError} from '../../src/server/backing/buy-orders.ts';
import {submitListenerObservation} from '../../src/server/data/listener-observations.ts';
const url=process.env.TEST_OBSERVATION_DATABASE_URL;
if(!url||!new URL(url).pathname.endsWith('_test'))throw Error('Explicit disposable observation test database required.');

test('upgrade preserves legacy quotes and money while detecting unsafe historical review chains',async()=>{
  const root=resolve('.'),temp=await mkdtemp(join(tmpdir(),'firstpress-review-upgrade-'));
  const name='first_press_upgrade_'+randomUUID().replaceAll('-','')+'_test',target=new URL(url);target.pathname='/'+name;
  const admin=new pg.Pool({connectionString:url}),pool=new pg.Pool({connectionString:target.toString()});
  const migrate=cwd=>{const r=spawnSync(process.execPath,['scripts/db/migrate.mjs'],{cwd,env:{...process.env,DATABASE_URL:target.toString()},encoding:'utf8',timeout:60000});assert.equal(r.status,0,r.stdout+r.stderr);};
  await admin.query(`CREATE DATABASE "${name}"`);
  try{
    // Rehearse a genuine seven-migration C04 database using unchanged applied SQL,
    // not direct migration-journal edits or a second migration runner.
    await mkdir(join(temp,'drizzle/meta'),{recursive:true});await mkdir(join(temp,'scripts/db'),{recursive:true});
    await symlink(join(root,'node_modules'),join(temp,'node_modules'));
    const journal=JSON.parse(await readFile('drizzle/meta/_journal.json','utf8'));journal.entries=journal.entries.slice(0,7);
    await writeFile(join(temp,'drizzle/meta/_journal.json'),JSON.stringify(journal));
    for(const entry of journal.entries)await copyFile(join(root,'drizzle',entry.tag+'.sql'),join(temp,'drizzle',entry.tag+'.sql'));
    for(const file of ['migrate.mjs','connection.mjs'])await copyFile(join(root,'scripts/db',file),join(temp,'scripts/db',file));
    await writeFile(join(temp,'drizzle.config.ts'),"export default {dialect:'postgresql',out:'./drizzle',dbCredentials:{url:process.env.DATABASE_URL}};");
    migrate(temp);
    await pool.query("INSERT INTO beta_invites(email,created_by,expires_at) VALUES ('upgrade@example.invalid','fixture',now()+interval '1 day')");
    await pool.query("INSERT INTO \"user\"(id,name,email,email_verified) VALUES ('upgrade','Upgrade Fixture','upgrade@example.invalid',true)");
    await pool.query("UPDATE members SET role='admin' WHERE user_id='upgrade'");
    const db=drizzle(pool,{schema});await initializeWallet(db,'upgrade');
    const now=Date.now();
    async function artist(id,spotify){await pool.query("INSERT INTO artists(id,slug,name,spotify_artist_id,status) VALUES ($1,$1,'Upgrade Fixture',$2,'active')",[id,spotify]);return {id,spotify};}
    async function capture(a,amount,age,status='accepted',parent=null,reasons=[]){
      const id=randomUUID(),snapshot=status==='accepted'?randomUUID():null,at=new Date(now-1000);
      const payload={artistId:a.id,sourceEventKey:id,provider:'spotify',metric:'monthly_listeners',providerArtistId:a.spotify,listenerCount:amount,
        sourceUrl:'https://open.spotify.com/artist/'+a.spotify,evidence:{reference:'fixture/'+id+'.png',sha256:'a'.repeat(64)},parserVersion:'manual-legacy-v1',
        observedAt:new Date(now-age).toISOString(),fetchedAt:new Date(now-age+1000).toISOString(),sourceUpdatedAt:null,
        ...(parent?{correctsObservationId:parent,reviewReason:'Reviewed a count under the original weak v1 rules.'}:{})};
      if(snapshot)await pool.query(`INSERT INTO listener_snapshots(id,artist_id,status,listener_count,source_url,source_event_key,evidence,parser_version,observed_at,fetched_at,accepted_at,reviewed_by)
        VALUES ($1,$2,'accepted',$3,$4,$5,$6,$7,$8,$9,$10,'upgrade')`,[snapshot,a.id,amount,payload.sourceUrl,'observation:'+id,{...payload.evidence,observationId:id,validationVersion:'spotify-listeners-v1'},payload.parserVersion,payload.observedAt,payload.fetchedAt,at]);
      await pool.query(`INSERT INTO listener_observations(id,artist_id,source_event_key,payload_hash,payload,status,reasons,validation_version,snapshot_id,corrects_observation_id,actor_id,received_at)
        VALUES ($1,$2,$1,repeat('a',64),$3,$4,$5,'spotify-listeners-v1',$6,$7,'upgrade',$8)`,[id,a.id,payload,status,JSON.stringify(reasons),snapshot,parent,at]);
      return {id,payload};
    }
    const a=await artist('incident-chain','1111111111111111111111'),b=await artist('outlier-reuse','2222222222222222222222'),clean=await artist('clean-history','3333333333333333333333');
    const first=await capture(a,'10000',600000),blocked=await capture(a,'11000',120000,'quarantined',first.id,['accepted_correction_requires_incident_review']);
    await capture(a,'11000',110000,'accepted',blocked.id); // Original laundering defect.
    await capture(b,'10000',600000);const candidate=await capture(b,'20000',120000,'quarantined',null,['listener_change_requires_review']);
    await capture(b,'1000000000000',110000,'accepted',candidate.id); // Original unrelated-candidate defect.
    await capture(clean,'10000',600000);
    const state=async()=>JSON.stringify({quotes:(await pool.query('SELECT * FROM listener_snapshots ORDER BY id')).rows,
      captures:(await pool.query('SELECT * FROM listener_observations ORDER BY id')).rows,wallet:(await pool.query('SELECT * FROM wallets ORDER BY user_id')).rows,
      ledger:(await pool.query('SELECT * FROM ledger_events ORDER BY id')).rows});
    const before=await state();migrate(root);assert.equal(await state(),before,'No historical evidence or money is rewritten.');
    assert.equal((await pool.query('SELECT count(*)::int n FROM drizzle.__drizzle_migrations')).rows[0].n,9);
    for(const unsafe of [a,b]){
      assert.equal((await pool.query('SELECT fp_observation_artist_needs_review($1) blocked',[unsafe.id])).rows[0].blocked,true);
      await assert.rejects(placeBuy(db,'upgrade',{artistId:unsafe.id,amountCents:'100',idempotencyKey:randomUUID()}),e=>e instanceof OrderError&&e.code==='ineligible');
      const next=await submitListenerObservation(db,'upgrade',{...first.payload,artistId:unsafe.id,providerArtistId:unsafe.spotify,sourceUrl:'https://open.spotify.com/artist/'+unsafe.spotify,
        listenerCount:'10000',sourceEventKey:randomUUID(),observedAt:new Date(now-60000).toISOString(),fetchedAt:new Date(now-59000).toISOString()});
      assert.equal(next.status,'quarantined');assert.ok(next.reasons.includes('disputed_history_requires_incident_review'));
    }
    assert.equal((await pool.query('SELECT fp_observation_artist_needs_review($1) blocked',[clean.id])).rows[0].blocked,false);
    const order=await placeBuy(db,'upgrade',{artistId:clean.id,amountCents:'100',idempotencyKey:randomUUID()});assert.equal(order.created,true);
  }finally{await pool.end();await admin.query(`DROP DATABASE "${name}"`);await admin.end();await rm(temp,{recursive:true,force:true});}
});

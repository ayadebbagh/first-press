// A05 / https://github.com/ayadebbagh/first-press/issues/23
// Real Next HTTP, invited/verified accounts, local STARTTLS mail and isolated PG.
// Historical settled-lot fixtures are setup, NOT evidence of live A06 settlement.
import {test,expect} from 'playwright/test';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import * as schema from '../../src/server/db/schema.ts';
import {seedSettledLots,assertTestDatabase} from '../helpers/settled-lots.mjs';

const base='http://127.0.0.1:3101';
const databaseUrl=process.env.TEST_AUTH_DATABASE_URL;
if(!databaseUrl||!new URL(databaseUrl).pathname.endsWith('_auth_test'))throw Error('An isolated TEST_AUTH_DATABASE_URL ending _auth_test is required.');
const pool=new pg.Pool({connectionString:databaseUrl,application_name:'first-press-exits-browser-test'});
const db=drizzle(pool,{schema});
const headers={origin:base};
const password='isolated-browser-password-123';
const email=()=>`exits-${randomUUID()}@example.invalid`;
const endpoint='/api/account/orders/exit';
const Q=1_000_000_000_000n;
const DAY=86_400_000;
const defaultLots=[{principalCents:'10000',entryListenerCount:'10000'},{principalCents:'20000',entryListenerCount:'20000'}];
const exitIntent=(artistId,exitBasisPoints=10000,idempotencyKey=randomUUID())=>({artistId,exitBasisPoints,idempotencyKey});
const exitKey=userId=>'first-press:pending-server-exit:'+userId;
const buyKey=userId=>'first-press:pending-server-buy:'+userId;
let admin,adminId;

// Keep the actual invite -> delivered verification -> sign-in flow from A04.
async function invite(address){
  await pool.query("INSERT INTO beta_invites(email,created_by,expires_at) VALUES ($1,'exits-browser-fixture',now()+interval '1 day')",[address]);
}
async function deliver(address){
  for(let i=0;i<30;i++){
    const {rows:[mail]}=await pool.query("SELECT status FROM mail_outbox WHERE recipient=$1 AND purpose='verification' ORDER BY created_at DESC LIMIT 1",[address]);
    if(mail?.status==='sent')break;
    execFileSync(process.execPath,['scripts/auth/mail-worker.mjs','--once'],{env:{...process.env,DATABASE_URL:databaseUrl},stdio:'pipe',timeout:10000});
  }
  const {rows:[mail]}=await pool.query("SELECT status,body FROM mail_outbox WHERE recipient=$1 AND purpose='verification' ORDER BY created_at DESC LIMIT 1",[address]);
  expect(mail).toEqual({status:'sent',body:null});
  const messages=await(await fetch('http://127.0.0.1:8026/messages')).json();
  const message=messages.filter(value=>value.includes(address)&&value.includes('Verify your')).at(-1);
  expect(message).toBeTruthy();
  return message.match(/http:\/\/127\.0\.0\.1:3101\/[^\s]+/)[0];
}
async function profile(context){
  const response=await context.request.get('/api/account/profile');expect(response.status()).toBe(200);
  return response.json();
}
async function register(context,address=email()){
  await invite(address);
  expect((await context.request.post('/api/auth/sign-up/email',{headers,data:{email:address,password,name:'Exit Fixture',callbackURL:base+'/account'}})).ok()).toBeTruthy();
  expect((await context.request.get('/api/account/profile')).status()).toBe(401);
  expect((await context.request.get(await deliver(address))).ok()).toBeTruthy();
  expect((await context.request.post('/api/auth/sign-in/email',{headers,data:{email:address,password}})).ok()).toBeTruthy();
  return {member:await profile(context),address};
}
async function registerOnPage(page,context){
  const address=email();await invite(address);
  await page.goto('/account');
  await page.getByRole('button',{name:'Have an invitation? Create account',exact:true}).click();
  await page.getByLabel('Display name',{exact:true}).fill('Early Exit Backer');
  await page.getByLabel('Email',{exact:true}).fill(address);
  await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Create account ↗',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'check your inbox'})).toBeVisible();
  expect((await context.request.get('/api/account/profile')).status()).toBe(401);
  await page.goto(await deliver(address));
  await expect(page.getByLabel('Email',{exact:true})).toBeVisible();
  await page.getByLabel('Email',{exact:true}).fill(address);
  await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Sign in ↗',exact:true}).click();
  await expect(page.getByRole('heading',{name:/Good to see you/})).toBeVisible();
  await expect(page.getByRole('button',{name:'Initialize my server wallet ↗',exact:true})).toBeVisible();
  const member=await profile(context);expect(member.role).toBe('member');return member;
}
async function initialize(context){
  const before=await context.request.get('/api/account/wallet');expect(before.status()).toBe(200);
  expect((await before.json()).wallet).toBeNull();
  const response=await context.request.post('/api/account/wallet',{headers,data:{}});
  expect(response.status()).toBe(201);
  expect((await response.json()).wallet).toEqual({availableCents:'100000',reservedCents:'0'});
}
async function captureObservation(artist,{listenerCount='12345',ageMs=60_000}={}){
  const {rows:[clock]}=await pool.query('SELECT clock_timestamp() AS now');
  const observedAt=new Date(clock.now.getTime()-ageMs).toISOString();
  const payload={artistId:artist.id,sourceEventKey:randomUUID(),provider:'spotify',metric:'monthly_listeners',providerArtistId:artist.spotify,
    listenerCount,sourceUrl:'https://open.spotify.com/artist/'+artist.spotify,
    evidence:{reference:'fixture/exits-browser/'+randomUUID()+'.json',sha256:'b'.repeat(64)},parserVersion:'a05-browser-admin-fixture-v1',
    observedAt,fetchedAt:new Date(Date.parse(observedAt)+1000).toISOString(),sourceUpdatedAt:null};
  const response=await admin.request.post('/api/admin/listener-observations',{headers,data:payload});expect(response.status()).toBe(201);
  const observation=await response.json();
  expect(observation).toMatchObject({status:'accepted',validationVersion:'spotify-listeners-v2',reasons:[]});
  expect(observation.snapshotId).toBeTruthy();
  const {rows:[snapshot]}=await pool.query('SELECT synthetic,status,listener_count::text,observed_at,accepted_at FROM listener_snapshots WHERE id=$1',[observation.snapshotId]);
  expect(snapshot).toMatchObject({synthetic:false,status:'accepted',listener_count:listenerCount});
  expect(snapshot.observed_at.toISOString()).toBe(observedAt);
  return {snapshotId:observation.snapshotId,observedAt,listenerCount,acceptedAt:snapshot.accepted_at};
}
async function createArtist(options){
  const id=randomUUID(),artist={id,name:'Exit Browser Artist '+id.slice(0,8),spotify:id.replaceAll('-','').slice(0,22)};
  await pool.query("INSERT INTO artists(id,slug,name,spotify_artist_id,status,synthetic) VALUES ($1,$1,$2,$3,'active',false)",[id,artist.name,artist.spotify]);
  return {...artist,...await captureObservation(artist,options)};
}
async function seed(member,artist,lots=defaultLots){
  // Helper checks the actual connected DB name, and writes guard-valid past
  // buys/quotes/settlements/ledger/receipts. All exit mutations still use HTTP.
  const seeded=await seedSettledLots(db,{userId:member.id,artistId:artist.id,adminId,lots});
  const {rows:[latest]}=await pool.query("SELECT id FROM listener_snapshots WHERE artist_id=$1 AND status='accepted' ORDER BY observed_at DESC,accepted_at DESC LIMIT 1",[artist.id]);
  expect(latest.id).toBe(artist.snapshotId);
  for(const lot of seeded){
    expect(lot.receiptId).toBeTruthy();expect(lot.entrySnapshotId).toBeTruthy();
    expect(lot.acceptedAt.getTime()).toBeLessThan(lot.executedAt.getTime());
    expect(lot.executedAt.getTime()).toBeLessThan(Date.parse(artist.observedAt));
  }
  return seeded;
}
async function fixture(context,{page,observation}={}){
  const member=page?await registerOnPage(page,context):(await register(context)).member;
  await initialize(context);
  const artist=await createArtist(observation),lots=await seed(member,artist);
  if(page){await page.reload();await expect(positions(page).getByText(artist.name,{exact:true})).toBeVisible();}
  return {member,artist,lots};
}
async function desk(context){
  const response=await context.request.get('/api/account/backing');expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toContain('no-store');return response.json();
}
async function wallet(context){
  const response=await context.request.get('/api/account/wallet');expect(response.status()).toBe(200);return (await response.json()).wallet;
}
const postExit=(context,data)=>context.request.post(endpoint,{headers,data});
const cancel=(context,id,data={})=>context.request.post(`/api/account/orders/${id}/cancel`,{headers,data});
async function orderDetail(context,id){
  const response=await context.request.get('/api/account/orders/'+id);expect(response.status()).toBe(200);return response.json();
}
async function error(response,status,code,intentAbsent){
  expect(response.status()).toBe(status);expect(response.headers()['cache-control']).toContain('no-store');
  const value=await response.json();expect(value).toMatchObject({error:expect.any(String),code,intentAbsent});return value;
}
async function earlyEvidence(userId){
  return (await pool.query(`SELECT r.id receipt_id,r.created_at receipt_created_at,l.id lot_id,l.buy_order_id,l.entry_snapshot_id,
    l.principal_cents::text,l.entry_listener_count::text,l.initial_quanta::text,l.created_at,l.economy_version,
    o.accepted_at,o.settled_at,o.placement_snapshot_id,s.observed_at,s.fetched_at,s.source_updated_at,s.source_url,s.evidence
    FROM receipt_events r JOIN position_lots l ON l.id=r.lot_id JOIN orders o ON o.id=l.buy_order_id
    JOIN listener_snapshots s ON s.id=l.entry_snapshot_id WHERE l.user_id=$1 ORDER BY r.id`,[userId])).rows;
}
async function moneyHistory(userId){
  const {rows:[history]}=await pool.query(`SELECT
    (SELECT to_jsonb(w) FROM wallets w WHERE w.user_id=$1) wallet,
    (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]') FROM ledger_events e WHERE e.user_id=$1) ledger,
    (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.order_id),'[]') FROM cash_reservations c WHERE c.user_id=$1) cash,
    (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.order_id),'[]') FROM settlements s WHERE s.user_id=$1) settlements,
    (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') FROM receipt_events r JOIN position_lots l ON l.id=r.lot_id WHERE l.user_id=$1) receipts`,[userId]);
  return history;
}
async function accountState(userId){
  return {money:await moneyHistory(userId),evidence:await earlyEvidence(userId),
    orders:(await pool.query('SELECT * FROM orders WHERE user_id=$1 ORDER BY id',[userId])).rows,
    lots:(await pool.query('SELECT * FROM position_lots WHERE user_id=$1 ORDER BY id',[userId])).rows,
    allocations:(await pool.query('SELECT * FROM exit_allocations WHERE user_id=$1 ORDER BY order_id,lot_id',[userId])).rows};
}
async function quantities(userId){
  const rows=(await pool.query(`SELECT l.id,l.remaining_quanta::text,l.reserved_quanta::text,
    coalesce(sum(a.quanta) FILTER(WHERE a.status='held'),0)::text held
    FROM position_lots l LEFT JOIN exit_allocations a ON a.lot_id=l.id WHERE l.user_id=$1 GROUP BY l.id ORDER BY l.id`,[userId])).rows;
  for(const lot of rows){expect(lot.remaining_quanta).toBe(String(Q));expect(lot.reserved_quanta).toBe(lot.held);}
  return rows;
}
async function storedAllocations(userId,orderId){
  return (await pool.query('SELECT lot_id,quanta::text,status,proceeds_cents::text,created_at,resolved_at FROM exit_allocations WHERE user_id=$1 AND order_id=$2 ORDER BY lot_id',[userId,orderId])).rows;
}
function allocationMap(order){return Object.fromEntries(order.allocations.map(a=>[a.lotId,a.quanta]));}
function expectedAllocations(lots,quanta){return Object.fromEntries(lots.map(lot=>[lot.lotId,String(quanta)]));}
function positions(page){return page.getByRole('region',{name:'Your current backing',exact:true});}
function rows(page,artist){return page.getByRole('listitem').filter({has:page.getByRole('heading',{name:artist.name,exact:true})});}
function exitRow(page,artist){return rows(page,artist).filter({hasText:'OF AVAILABLE BACKING AT PLACEMENT'});}
async function balances(page,available='700',reserved='0'){
  const display=page.getByLabel('Server Credit balances',{exact:true});
  await expect(display.getByText('AVAILABLE CREDITS',{exact:true}).locator('..').locator('strong')).toHaveText(available+'CR');
  await expect(display.getByText('RESERVED CREDITS',{exact:true}).locator('..').locator('strong')).toHaveText(reserved+'CR');
}
async function prepareExit(page,artist,percent='25.37'){
  await page.getByRole('combobox',{name:'Backing to exit',exact:true}).selectOption(artist.id);
  await page.getByLabel('Percentage of available backing',{exact:true}).fill(percent);
}
async function capture(page,info,state){
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath(`exits-${state}-${info.project.name}.png`),fullPage:true});
}
function mutationResponse(page,path=endpoint){
  return page.waitForResponse(response=>new URL(response.url()).pathname===path&&response.request().method()==='POST');
}

test.beforeAll(async({browser})=>{
  await assertTestDatabase(db);
  expect((await pool.query('SELECT current_database() AS name')).rows[0].name).toMatch(/_auth_test$/);
  // The mail worker must use the existing local TLS fixture, never a provider.
  expect(process.env.SMTP_HOST).toBe('127.0.0.1');expect(process.env.SMTP_PORT).toBe('2587');
  // Only rate/action state is reset. Never truncate money, orders or history.
  await pool.query('TRUNCATE rate_limit,action_limits');
  admin=await browser.newContext({baseURL:base});
  const {member,address}=await register(admin);adminId=member.id;
  await pool.query("UPDATE members SET role='admin' WHERE user_id=$1",[adminId]);
  expect((await admin.request.post('/api/auth/sign-in/email',{headers,data:{email:address,password}})).ok()).toBeTruthy();
  expect((await profile(admin)).role).toBe('admin');
});
test.beforeEach(async({page,context})=>{
  await pool.query('TRUNCATE rate_limit,action_limits');
  page.__exitErrors=[];page.on('pageerror',error=>page.__exitErrors.push(error.message));
  // No mocked wallet/orders/positions/identity authority; only external fonts.
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//,route=>route.fulfill({status:200,contentType:'text/css',body:''}));
});
test.afterEach(async({page})=>{
  expect(page.__exitErrors).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test.afterAll(async()=>{await admin?.close();await pool.end();});

test('signed-in Account queues exact 25.37% and cancels persisted lot reservations without money or early-history changes',async({page,context},info)=>{
  const f=await fixture(context,{page}),before=await moneyHistory(f.member.id),evidence=await earlyEvidence(f.member.id);
  expect(evidence.map(r=>r.receipt_id).sort()).toEqual(f.lots.map(l=>l.receiptId).sort());
  expect(evidence.map(r=>r.principal_cents).sort()).toEqual(['10000','20000']);
  expect(evidence.map(r=>r.entry_listener_count).sort()).toEqual(['10000','20000']);
  for(const lot of f.lots)expect(evidence.find(r=>r.lot_id===lot.lotId)).toMatchObject({receipt_id:lot.receiptId,buy_order_id:lot.orderId,
    entry_snapshot_id:lot.entrySnapshotId,principal_cents:String(lot.principalCents),entry_listener_count:String(lot.entryListenerCount),
    accepted_at:lot.acceptedAt,settled_at:lot.executedAt});
  const initial=await desk(context);expect(initial.orders).toHaveLength(2);expect(initial.orders.every(o=>o.side==='buy'&&o.status==='settled')).toBe(true);
  expect(initial.positions).toEqual([{artistId:f.artist.id,artistName:f.artist.name,lotCount:2,availableLotCount:2,reservedLotCount:0,
    estimatedValueCents:'24690',estimatedAvailableCents:'24690',listenerCount:'12345',observedAt:f.artist.observedAt,stale:false,canExit:true}]);
  await balances(page);await expect(positions(page)).toContainText('246.90 CR');
  await expect(positions(page).locator('time')).toHaveAttribute('datetime',f.artist.observedAt);
  await prepareExit(page,f.artist);
  const pending=mutationResponse(page);
  await page.getByRole('button',{name:'Queue server exit ↗',exact:true}).click();
  const response=await pending;expect(response.status()).toBe(201);expect(response.headers()['cache-control']).toContain('no-store');
  const result=await response.json(),order=result.order;
  expect(response.request().postDataJSON()).toEqual({artistId:f.artist.id,exitBasisPoints:2537,idempotencyKey:expect.any(String)});
  expect(result).toMatchObject({created:true,wallet:{availableCents:'70000',reservedCents:'0'}});
  expect(order).toMatchObject({side:'sell',artistId:f.artist.id,status:'queued',amountCents:null,exitBasisPoints:2537,estimatedProceedsCents:'6262',
    economyVersion:'backing-v1',settledAt:null,cancelledAt:null,pendingStatus:'awaiting_update',
    placement:{snapshotId:f.artist.snapshotId,listenerCount:'12345',observedAt:f.artist.observedAt}});
  expect(allocationMap(order)).toEqual(expectedAllocations(f.lots,253_700_000_000n));
  expect(order.allocations.every(a=>a.status==='held')).toBe(true);
  expect(Date.parse(order.acceptedAt)).toBeGreaterThanOrEqual(f.artist.acceptedAt.getTime());
  expect(Date.parse(order.earliestCutoff)).toBe((Math.floor(Date.parse(order.acceptedAt)/43_200_000)+1)*43_200_000);
  const {rows:[stored]}=await pool.query('SELECT accepted_at,earliest_cutoff,placement_snapshot_id FROM orders WHERE id=$1 AND user_id=$2',[order.id,f.member.id]);
  expect(stored.accepted_at.toISOString()).toBe(order.acceptedAt);expect(stored.earliest_cutoff.toISOString()).toBe(order.earliestCutoff);
  expect(stored.placement_snapshot_id).toBe(f.artist.snapshotId);
  const held=await storedAllocations(f.member.id,order.id);
  expect(held).toHaveLength(2);
  for(const allocation of held){expect(allocation).toMatchObject({quanta:'253700000000',status:'held',proceeds_cents:null,resolved_at:null});expect(allocation.created_at.toISOString()).toBe(order.acceptedAt);}
  for(const lot of await quantities(f.member.id))expect(lot.reserved_quanta).toBe('253700000000');
  expect(result.positions).toEqual([{...initial.positions[0],reservedLotCount:2,estimatedAvailableCents:'18426'}]);
  await expect(exitRow(page,f.artist).getByText('QUEUED',{exact:true})).toBeVisible();
  await expect(exitRow(page,f.artist)).toContainText('25.37%');await expect(exitRow(page,f.artist)).toContainText('62.62 CR');
  await expect(exitRow(page,f.artist)).toContainText('Final payout depends on the execution listener count');
  await expect(exitRow(page,f.artist)).toContainText('This is not credited funds');
  for(const [label,value] of [['Accepted by server',order.acceptedAt],['First eligible update',order.earliestCutoff],['Placement estimate',f.artist.observedAt]]){
    await expect(exitRow(page,f.artist).getByText(label,{exact:true}).locator('..').locator('time')).toHaveAttribute('datetime',value);
  }
  await balances(page);expect(await moneyHistory(f.member.id)).toEqual(before);expect(await earlyEvidence(f.member.id)).toEqual(evidence);
  await page.reload();await balances(page);
  await expect(exitRow(page,f.artist).getByText('QUEUED',{exact:true})).toBeVisible();
  await expect(positions(page)).toContainText('184.26 CR');
  const reloaded=await desk(context);expect(reloaded.orders.map(o=>o.id)).toEqual([order.id,...initial.orders.map(o=>o.id)]);
  expect(reloaded.orders[0]).toEqual(order);await capture(page,info,'queued');
  const cancelling=mutationResponse(page,`/api/account/orders/${order.id}/cancel`);
  await exitRow(page,f.artist).getByRole('button',{name:'Cancel exit for '+f.artist.name,exact:true}).click();
  const cancelledResponse=await cancelling;expect(cancelledResponse.status()).toBe(200);
  const cancelled=await cancelledResponse.json();expect(cancelled).toMatchObject({cancelled:true,order:{id:order.id,side:'sell',status:'cancelled'},wallet:result.wallet});
  expect(cancelled.positions).toEqual(initial.positions);
  await expect(exitRow(page,f.artist).getByText('CANCELLED',{exact:true})).toBeVisible();
  await expect(exitRow(page,f.artist)).toContainText('no Credits credited or refunded');
  await expect(exitRow(page,f.artist)).toContainText('Original support history retained');
  await balances(page);await page.reload();await balances(page);
  await expect(exitRow(page,f.artist).getByText('CANCELLED',{exact:true})).toBeVisible();await capture(page,info,'cancelled');
  const released=await storedAllocations(f.member.id,order.id);
  expect(released.map(a=>a.quanta)).toEqual(held.map(a=>a.quanta));
  for(const allocation of released){expect(allocation.status).toBe('released');expect(allocation.proceeds_cents).toBeNull();expect(allocation.resolved_at.toISOString()).toBe(cancelled.order.cancelledAt);}
  for(const lot of await quantities(f.member.id))expect(lot.reserved_quanta).toBe('0');
  const repeat=await cancel(context,order.id);expect(repeat.status()).toBe(200);expect(await repeat.json()).toMatchObject({cancelled:false,order:cancelled.order,wallet:result.wallet,positions:initial.positions});
  expect(await earlyEvidence(f.member.id)).toEqual(evidence);expect(await moneyHistory(f.member.id)).toEqual(before);
});

test('simultaneous full exits reserve only currently available quanta; later fixture buys and actual new quotes cannot enlarge frozen allocations',async({context})=>{
  const f=await fixture(context),before=await moneyHistory(f.member.id),evidence=await earlyEvidence(f.member.id);
  const partialResponse=await postExit(context,exitIntent(f.artist.id,5000));expect(partialResponse.status()).toBe(201);
  const partial=(await partialResponse.json()).order;expect(allocationMap(partial)).toEqual(expectedAllocations(f.lots,Q/2n));
  const intents=[exitIntent(f.artist.id),exitIntent(f.artist.id)];
  const responses=await Promise.all(intents.map(intent=>postExit(context,intent)));
  expect(responses.map(r=>r.status()).sort()).toEqual([201,422]);
  const winningIndex=responses.findIndex(r=>r.status()===201),fullResult=await responses[winningIndex].json(),full=fullResult.order;
  await error(responses[1-winningIndex],422,'ineligible',true);
  expect(allocationMap(full)).toEqual(expectedAllocations(f.lots,Q/2n));
  expect(fullResult.positions[0]).toMatchObject({lotCount:2,availableLotCount:0,reservedLotCount:2,estimatedAvailableCents:'0',canExit:false});
  await error(await postExit(context,exitIntent(f.artist.id)),422,'ineligible',true);
  expect(await wallet(context)).toEqual({availableCents:'70000',reservedCents:'0'});expect(await moneyHistory(f.member.id)).toEqual(before);
  for(const lot of await quantities(f.member.id))expect(lot.reserved_quanta).toBe(String(Q));
  const frozen=await storedAllocations(f.member.id,full.id);
  // A later settled backing is another explicitly historical setup fixture.
  // It consumes real fixture principal, so take a NEW money baseline after it.
  const [later]=await seed(f.member,f.artist,[{principalCents:'5000',entryListenerCount:'10000'}]);
  const afterFixture=await moneyHistory(f.member.id);
  const newer=await captureObservation(f.artist,{listenerCount:'13579',ageMs:30_000});
  const detail=await orderDetail(context,full.id);expect(detail).toEqual(full);
  const replay=await postExit(context,intents[winningIndex]);expect(replay.status()).toBe(200);
  expect(await replay.json()).toMatchObject({created:false,order:full,wallet:{availableCents:'65000',reservedCents:'0'}});
  expect(await storedAllocations(f.member.id,full.id)).toEqual(frozen);
  expect(await orderDetail(context,partial.id)).toEqual(partial);
  const current=(await desk(context)).positions[0];expect(current).toMatchObject({lotCount:3,availableLotCount:1,reservedLotCount:2,listenerCount:'13579',observedAt:newer.observedAt,canExit:true});
  expect((await quantities(f.member.id)).find(l=>l.id===later.lotId).reserved_quanta).toBe('0');
  const lastResponse=await postExit(context,exitIntent(f.artist.id));expect(lastResponse.status()).toBe(201);
  const last=(await lastResponse.json()).order;expect(allocationMap(last)).toEqual({[later.lotId]:String(Q)});
  await error(await postExit(context,exitIntent(f.artist.id)),422,'ineligible',true);
  for(const order of [partial,full,last]){const response=await cancel(context,order.id);expect(response.status()).toBe(200);expect((await response.json()).cancelled).toBe(true);}
  expect(await moneyHistory(f.member.id)).toEqual(afterFixture);
  for(const row of evidence)expect((await earlyEvidence(f.member.id)).find(r=>r.receipt_id===row.receipt_id)).toEqual(row);
  for(const lot of await quantities(f.member.id))expect(lot.reserved_quanta).toBe('0');
});

test('minimum and repeated fractional exits round down to whole quanta; full exit takes every remaining quantum exactly once',async({context})=>{
  const f=await fixture(context),before=await moneyHistory(f.member.id),evidence=await earlyEvidence(f.member.id),orders=[];
  // Fixed arithmetic examples include fractional-quantum truncation on the
  // third/fourth 33.33% requests, then a 100% exit of the exact residue.
  for(const [bp,quanta] of [[1,'100000000'],[3333,'333266670000'],[3333,'222188888889'],[3333,'148133332222'],[3333,'98760492592'],[10000,'197550616297']]){
    const response=await postExit(context,exitIntent(f.artist.id,bp));expect(response.status()).toBe(201);
    const result=await response.json();expect(allocationMap(result.order)).toEqual(expectedAllocations(f.lots,quanta));
    expect(result.wallet).toEqual({availableCents:'70000',reservedCents:'0'});orders.push(result.order);
  }
  for(const lot of f.lots)expect(orders.reduce((sum,order)=>sum+BigInt(allocationMap(order)[lot.lotId]),0n)).toBe(Q);
  for(const lot of await quantities(f.member.id))expect(lot.reserved_quanta).toBe(String(Q));
  await error(await postExit(context,exitIntent(f.artist.id,1)),422,'ineligible',true);
  for(const order of orders.toReversed()){
    const response=await cancel(context,order.id);expect(response.status()).toBe(200);
    const result=await response.json();expect(result.cancelled).toBe(true);
    expect(allocationMap(result.order)).toEqual(allocationMap(order));expect(result.order.allocations.every(a=>a.status==='released')).toBe(true);
  }
  for(const lot of await quantities(f.member.id))expect(lot.reserved_quanta).toBe('0');
  expect(await moneyHistory(f.member.id)).toEqual(before);expect(await earlyEvidence(f.member.id)).toEqual(evidence);
});

test('lost successful exit response survives reload and paused artist; exact replay creates one order and leaves a separate buy retry intact',async({page,context})=>{
  const f=await fixture(context,{page}),before=await moneyHistory(f.member.id),evidence=await earlyEvidence(f.member.id);
  // Produce a real independent buy retry hint, without forwarding its request.
  await page.getByRole('combobox',{name:'Artist',exact:true}).selectOption(f.artist.id);
  await page.getByLabel('Credits to reserve',{exact:true}).fill('1.01');
  let unforwardedBuy;
  await page.route(base+'/api/account/orders',async route=>{unforwardedBuy=route.request().postDataJSON();await route.abort('failed');},{times:1});
  await page.getByRole('button',{name:'Queue server backing ↗',exact:true}).click();
  await expect(page.getByRole('button',{name:'Retry this same backing ↗',exact:true})).toBeVisible();
  const savedBuy=await page.evaluate(key=>sessionStorage.getItem(key),buyKey(f.member.id));expect(JSON.parse(savedBuy)).toEqual(unforwardedBuy);
  await prepareExit(page,f.artist);
  let lostIntent,lostResult;
  await page.route(base+endpoint,async route=>{
    lostIntent=route.request().postDataJSON();
    const accepted=await route.fetch();expect(accepted.status()).toBe(201);
    lostResult=await accepted.json();
    // The real POST committed; only delivery of its actual response is lost.
    await route.abort('failed');
  },{times:1});
  await page.getByRole('button',{name:'Queue server exit ↗',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'We could not confirm whether your exit was accepted.'})).toBeVisible();
  expect(lostIntent).toEqual({artistId:f.artist.id,exitBasisPoints:2537,idempotencyKey:expect.any(String)});
  expect(lostResult.created).toBe(true);expect(allocationMap(lostResult.order)).toEqual(expectedAllocations(f.lots,253_700_000_000n));
  expect(JSON.parse(await page.evaluate(key=>sessionStorage.getItem(key),exitKey(f.member.id)))).toEqual(lostIntent);
  const frozen=await storedAllocations(f.member.id,lostResult.order.id);
  await pool.query("UPDATE artists SET status='suspended' WHERE id=$1",[f.artist.id]);
  await page.reload();await balances(page);
  await expect(page.getByRole('combobox',{name:'Backing to exit',exact:true})).toBeDisabled();
  await expect(page.getByLabel('Percentage of available backing',{exact:true})).toHaveValue('25.37');
  await expect(page.getByLabel('Percentage of available backing',{exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Retry this same exit ↗',exact:true})).toBeEnabled();
  expect(await page.evaluate(key=>sessionStorage.getItem(key),buyKey(f.member.id))).toBe(savedBuy);
  const pending=mutationResponse(page);
  await page.getByRole('button',{name:'Retry this same exit ↗',exact:true}).click();
  const response=await pending;expect(response.status()).toBe(200);expect(response.request().postDataJSON()).toEqual(lostIntent);
  expect(await response.json()).toMatchObject({created:false,order:lostResult.order,wallet:lostResult.wallet});
  await expect(page.getByRole('button',{name:'Retry this same exit ↗',exact:true})).toHaveCount(0);
  expect(await page.evaluate(key=>sessionStorage.getItem(key),exitKey(f.member.id))).toBeNull();
  expect(await page.evaluate(key=>sessionStorage.getItem(key),buyKey(f.member.id))).toBe(savedBuy);
  await expect(page.getByRole('button',{name:'Retry this same backing ↗',exact:true})).toBeVisible();
  await expect(exitRow(page,f.artist)).toHaveCount(1);
  const history=await desk(context);expect(history.orders).toHaveLength(3);expect(history.orders.filter(o=>o.side==='sell').map(o=>o.id)).toEqual([lostResult.order.id]);
  expect((await pool.query("SELECT id FROM orders WHERE user_id=$1 AND request_key=$2",[f.member.id,lostIntent.idempotencyKey])).rows).toEqual([{id:lostResult.order.id}]);
  expect(await storedAllocations(f.member.id,lostResult.order.id)).toEqual(frozen);
  expect(await moneyHistory(f.member.id)).toEqual(before);expect(await earlyEvidence(f.member.id)).toEqual(evidence);
  await error(await postExit(context,exitIntent(f.artist.id,1)),422,'ineligible',true);
  await expect(page.getByRole('button',{name:'Queue server exit ↗',exact:true})).toBeDisabled();
  const cancellation=mutationResponse(page,`/api/account/orders/${lostResult.order.id}/cancel`);
  await exitRow(page,f.artist).getByRole('button',{name:'Cancel exit for '+f.artist.name,exact:true}).click();
  expect((await cancellation).status()).toBe(200);
  await expect(exitRow(page,f.artist).getByText('CANCELLED',{exact:true})).toBeVisible();await balances(page);
  expect(await moneyHistory(f.member.id)).toEqual(before);expect(await earlyEvidence(f.member.id)).toEqual(evidence);
  for(const lot of await quantities(f.member.id))expect(lot.reserved_quanta).toBe('0');
});

test('real exit API strictly rejects fractional, string and out-of-range BP and malformed intent identifiers atomically',async({context})=>{
  const f=await fixture(context),intent=exitIntent(f.artist.id,2537),before=await accountState(f.member.id);
  // Fewer than the real 30/minute admission limit; no rate reset hides errors.
  for(const exitBasisPoints of [undefined,null,true,false,'2537','10000',0,-1,0.01,25.37,10001,Number.MAX_SAFE_INTEGER]){
    await error(await postExit(context,{...intent,exitBasisPoints}),400,'invalid',false);
  }
  for(const idempotencyKey of ['',null,42,'short77','x'.repeat(129),'a bcdefg','abcdefgh.']){
    await error(await postExit(context,{...intent,idempotencyKey}),400,'invalid',false);
  }
  for(const artistId of ['',null,42,'  ','x'.repeat(201),'bad\u0000artist','bad\ud800artist']){
    await error(await postExit(context,{...intent,artistId}),400,'invalid',false);
  }
  for(const data of [[],{}])await error(await postExit(context,data),400,'invalid',false);
  expect(await accountState(f.member.id)).toEqual(before);
});

test('real APIs isolate owned lots and sell history, reject injected authority, and dispatch strict idempotent cancellation',async({context,browser})=>{
  const f=await fixture(context),other=await browser.newContext({baseURL:base}),anonymous=await browser.newContext({baseURL:base});
  try{
    const {member:otherMember}=await register(other);
    await error(await postExit(other,exitIntent(f.artist.id)),409,'uninitialized',false);
    await initialize(other);
    await error(await postExit(other,exitIntent(f.artist.id)),422,'ineligible',true);
    const foreign=await seed(otherMember,f.artist,[{principalCents:'10000'}]);
    const second=await createArtist();const unrelated=await seed(f.member,second,[{principalCents:'10000'}]);
    const ownBefore=await accountState(f.member.id),otherBefore=await accountState(otherMember.id),intent=exitIntent(f.artist.id);
    expect((await postExit(anonymous,intent)).status()).toBe(401);
    expect((await context.request.post(endpoint,{headers:{origin:'https://attacker.invalid'},data:intent})).status()).toBe(403);
    expect((await context.request.post(endpoint,{data:intent})).status()).toBe(403);
    const injected={userId:otherMember.id,ownerId:otherMember.id,accountId:otherMember.id,lotId:foreign[0].lotId,lotIds:f.lots.map(l=>l.lotId),quanta:'1',
      allocations:[{lotId:foreign[0].lotId,quanta:'1'}],funds:'100000',amountCents:'1',price:'1',listenerCount:'1',estimatedProceedsCents:'999999',
      placementSnapshotId:f.artist.snapshotId,acceptedAt:'2000-01-01T00:00:00.000Z',earliestCutoff:'2000-01-01T12:00:00.000Z',now:0,side:'sell',status:'settled'};
    for(const [key,value] of Object.entries(injected))await error(await postExit(context,{...intent,[key]:value}),400,'invalid',false);
    expect((await postExit(context,{...intent,padding:'x'.repeat(4096)})).status()).toBe(413);
    expect((await context.request.post(endpoint,{headers:{...headers,'content-type':'application/json'},data:'{'})).status()).toBe(400);
    expect(await accountState(f.member.id)).toEqual(ownBefore);expect(await accountState(otherMember.id)).toEqual(otherBefore);
    const response=await postExit(context,intent);expect(response.status()).toBe(201);const result=await response.json();
    expect(allocationMap(result.order)).toEqual(expectedAllocations(f.lots,Q));
    expect((await quantities(f.member.id)).find(l=>l.id===unrelated[0].lotId).reserved_quanta).toBe('0');
    expect((await quantities(otherMember.id))[0].reserved_quanta).toBe('0');
    expect((await other.request.get('/api/account/orders/'+result.order.id)).status()).toBe(404);
    expect((await cancel(other,result.order.id)).status()).toBe(404);
    expect((await anonymous.request.get('/api/account/orders/'+result.order.id)).status()).toBe(401);
    expect((await cancel(anonymous,result.order.id)).status()).toBe(401);
    expect((await anonymous.request.get('/api/account/backing')).status()).toBe(401);
    expect(await orderDetail(context,result.order.id)).toEqual(result.order);
    // Even a query-string owner hint must not change the signed-in principal.
    const otherDesk=await other.request.get('/api/account/backing?userId='+f.member.id);expect(otherDesk.status()).toBe(200);
    const otherView=await otherDesk.json();expect(otherView.orders.map(o=>o.id)).toEqual(foreign.map(l=>l.orderId));
    expect(otherView.positions.map(p=>p.artistId)).toEqual([f.artist.id]);
    const ownDesk=await context.request.get('/api/account/backing?userId='+otherMember.id);expect(ownDesk.status()).toBe(200);
    expect((await ownDesk.json()).orders.map(o=>o.id)).toContain(result.order.id);
    await error(await postExit(context,{...intent,exitBasisPoints:9999}),409,'conflict',false);
    // Idempotency is per signed-in owner, not shared between the two accounts.
    const otherExit=await postExit(other,intent);expect(otherExit.status()).toBe(201);const otherOrder=(await otherExit.json()).order;
    expect(otherOrder.id).not.toBe(result.order.id);expect(allocationMap(otherOrder)).toEqual(expectedAllocations(foreign,Q));
    const cancelPath=`/api/account/orders/${result.order.id}/cancel`;
    expect((await context.request.post(cancelPath,{headers:{origin:'https://attacker.invalid'},data:{}})).status()).toBe(403);
    expect((await context.request.post(cancelPath,{data:{}})).status()).toBe(403);
    for(const data of [{userId:otherMember.id},{lotId:f.lots[0].lotId},{quanta:'1'},{amountCents:'1'},{price:'1'},{cancelledAt:'2000-01-01T00:00:00.000Z'},[]]){
      expect((await cancel(context,result.order.id,data)).status()).toBe(400);
    }
    expect((await cancel(context,result.order.id,{padding:'x'.repeat(4096)})).status()).toBe(413);
    expect((await context.request.post(cancelPath,{headers:{...headers,'content-type':'application/json'},data:'{'})).status()).toBe(400);
    const cancelled=await cancel(context,result.order.id);expect(cancelled.status()).toBe(200);const final=await cancelled.json();
    expect(final).toMatchObject({cancelled:true,order:{id:result.order.id,side:'sell',status:'cancelled'},wallet:result.wallet});
    const repeat=await cancel(context,result.order.id);expect(repeat.status()).toBe(200);expect((await repeat.json()).cancelled).toBe(false);
    const replay=await postExit(context,intent);expect(replay.status()).toBe(200);expect(await replay.json()).toMatchObject({created:false,order:final.order});
    expect((await storedAllocations(f.member.id,result.order.id)).every(a=>a.status==='released')).toBe(true);
    expect(await moneyHistory(f.member.id)).toEqual(ownBefore.money);expect(await earlyEvidence(f.member.id)).toEqual(ownBefore.evidence);
    expect((await cancel(other,otherOrder.id)).status()).toBe(200);expect(await moneyHistory(otherMember.id)).toEqual(otherBefore.money);
  }finally{await other.close();await anonymous.close();}
});

test('actual wall-clock expiry pauses fresh admission while existing stale backing stays visible and cancellable',async({page,context})=>{
  // The actual admin intake accepts this still-fresh source. Wait for its real
  // 24-hour boundary; never rewrite provenance or install a server clock bypass.
  const f=await fixture(context,{page,observation:{ageMs:DAY-10_000}}),before=await moneyHistory(f.member.id),evidence=await earlyEvidence(f.member.id);
  const intent=exitIntent(f.artist.id,2537),response=await postExit(context,intent);expect(response.status()).toBe(201);
  const placed=await response.json();
  await expect.poll(async()=>(await desk(context)).positions[0].stale,{timeout:20_000,intervals:[250,500,1000]}).toBe(true);
  await error(await postExit(context,exitIntent(f.artist.id,1)),422,'ineligible',true);
  const replay=await postExit(context,intent);expect(replay.status()).toBe(200);expect(await replay.json()).toMatchObject({created:false,order:placed.order,wallet:placed.wallet});
  const current=await desk(context);expect(current.artists.some(a=>a.id===f.artist.id)).toBe(false);
  expect(current.positions[0]).toMatchObject({artistId:f.artist.id,stale:true,canExit:false,listenerCount:'12345',observedAt:f.artist.observedAt,estimatedValueCents:'24690'});
  await page.reload();await balances(page);
  await expect(positions(page).getByText(f.artist.name,{exact:true})).toBeVisible();
  await expect(positions(page)).toContainText('STALE ESTIMATE');await expect(positions(page)).toContainText('12,345 Spotify monthly listeners');
  await expect(positions(page).locator('time')).toHaveAttribute('datetime',f.artist.observedAt);
  await expect(page.getByRole('button',{name:'Queue server exit ↗',exact:true})).toBeDisabled();
  const pending=mutationResponse(page,`/api/account/orders/${placed.order.id}/cancel`);
  await exitRow(page,f.artist).getByRole('button',{name:'Cancel exit for '+f.artist.name,exact:true}).click();
  const cancelled=await pending;expect(cancelled.status()).toBe(200);expect((await cancelled.json()).cancelled).toBe(true);
  await expect(exitRow(page,f.artist).getByText('CANCELLED',{exact:true})).toBeVisible();await balances(page);
  expect(await moneyHistory(f.member.id)).toEqual(before);expect(await earlyEvidence(f.member.id)).toEqual(evidence);
  for(const lot of await quantities(f.member.id))expect(lot.reserved_quanta).toBe('0');
});

test('unforwarded exit retries its exact key after all quantities are held; real intentAbsent proof clears only the absent retry',async({page,context})=>{
  const f=await fixture(context,{page}),before=await moneyHistory(f.member.id),evidence=await earlyEvidence(f.member.id);
  await prepareExit(page,f.artist,'100.00');let absent;
  await page.route(base+endpoint,async route=>{absent=route.request().postDataJSON();await route.abort('failed');},{times:1});
  await page.getByRole('button',{name:'Queue server exit ↗',exact:true}).click();
  await expect(page.getByRole('button',{name:'Retry this same exit ↗',exact:true})).toBeVisible();
  expect((await pool.query("SELECT count(*)::int n FROM orders WHERE user_id=$1 AND side='sell'",[f.member.id])).rows[0].n).toBe(0);
  const reservation=await postExit(context,exitIntent(f.artist.id));expect(reservation.status()).toBe(201);const held=await reservation.json();
  const frozen=await storedAllocations(f.member.id,held.order.id);
  await page.reload();await balances(page);
  await expect(positions(page)).toContainText('All backing is reserved');
  await expect(page.getByRole('button',{name:'Retry this same exit ↗',exact:true})).toBeEnabled();
  const pending=mutationResponse(page);
  await page.getByRole('button',{name:'Retry this same exit ↗',exact:true}).click();
  const response=await pending;expect(response.request().postDataJSON()).toEqual(absent);
  await error(response,422,'ineligible',true);
  await expect(page.getByRole('button',{name:'Retry this same exit ↗',exact:true})).toHaveCount(0);
  await expect(page.getByRole('status').filter({hasText:'There is no available backing for this exit percentage.'})).toBeVisible();
  expect(await page.evaluate(key=>sessionStorage.getItem(key),exitKey(f.member.id))).toBeNull();
  expect(await page.evaluate(key=>sessionStorage.getItem(key),buyKey(f.member.id))).toBeNull();
  expect((await pool.query('SELECT count(*)::int n FROM orders WHERE user_id=$1 AND request_key=$2',[f.member.id,absent.idempotencyKey])).rows[0].n).toBe(0);
  expect((await desk(context)).orders.filter(o=>o.side==='sell').map(o=>o.id)).toEqual([held.order.id]);
  expect(await storedAllocations(f.member.id,held.order.id)).toEqual(frozen);
  expect(await moneyHistory(f.member.id)).toEqual(before);expect(await earlyEvidence(f.member.id)).toEqual(evidence);
  for(const lot of await quantities(f.member.id))expect(lot.reserved_quanta).toBe(String(Q));
});

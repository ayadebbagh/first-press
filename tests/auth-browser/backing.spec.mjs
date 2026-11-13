// Issue #22 / A04: real Next HTTP, isolated PostgreSQL and delivered SMTP mail.
import {test,expect} from 'playwright/test';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import pg from 'pg';

const base='http://127.0.0.1:3101';
const databaseUrl=process.env.TEST_AUTH_DATABASE_URL;
if(!databaseUrl||!new URL(databaseUrl).pathname.endsWith('_auth_test'))throw Error('An isolated TEST_AUTH_DATABASE_URL ending _auth_test is required.');
const db=new pg.Pool({connectionString:databaseUrl,application_name:'first-press-backing-browser-test'});
const password='isolated-browser-password-123';
const email=()=>`backing-${randomUUID()}@example.invalid`;
const headers={origin:base};
const buy=(artistId,amountCents='25037',idempotencyKey=randomUUID())=>({artistId,amountCents,idempotencyKey});
let admin,artist;

async function invite(address){
  await db.query("INSERT INTO beta_invites(email,created_by,expires_at) VALUES ($1,'backing-browser-fixture',now()+interval '1 day')",[address]);
}
async function deliver(address){
  for(let i=0;i<30;i++){
    const {rows:[mail]}=await db.query("SELECT status FROM mail_outbox WHERE recipient=$1 AND purpose='verification' ORDER BY created_at DESC LIMIT 1",[address]);
    if(mail?.status==='sent')break;
    execFileSync(process.execPath,['scripts/auth/mail-worker.mjs','--once'],{env:{...process.env,DATABASE_URL:databaseUrl},stdio:'pipe',timeout:10000});
  }
  const {rows:[mail]}=await db.query("SELECT status,body FROM mail_outbox WHERE recipient=$1 AND purpose='verification' ORDER BY created_at DESC LIMIT 1",[address]);
  expect(mail).toEqual({status:'sent',body:null});
  const messages=await(await fetch('http://127.0.0.1:8026/messages')).json();
  const message=messages.filter(value=>value.includes(address)&&value.includes('Verify your')).at(-1);
  expect(message).toBeTruthy();
  return message.match(/http:\/\/127\.0\.0\.1:3101\/[^\s]+/)[0];
}
async function register(context,address){
  await invite(address);
  expect((await context.request.post('/api/auth/sign-up/email',{headers,data:{email:address,password,name:'Backing Fixture',callbackURL:base+'/account'}})).ok()).toBeTruthy();
  expect((await context.request.get(await deliver(address))).ok()).toBeTruthy();
  expect((await context.request.post('/api/auth/sign-in/email',{headers,data:{email:address,password}})).ok()).toBeTruthy();
}
async function signIn(page,address){
  await expect(page.getByLabel('Email',{exact:true})).toBeVisible();
  await page.getByLabel('Email',{exact:true}).fill(address);
  await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Sign in ↗',exact:true}).click();
  await expect(page.getByRole('heading',{name:/Good to see you/})).toBeVisible();
  await expect(page.getByRole('button',{name:'Initialize my server wallet ↗',exact:true})).toBeVisible();
}
async function registerOnPage(page,context){
  const address=email();await invite(address);
  await page.goto('/account');
  await page.getByRole('button',{name:'Have an invitation? Create account',exact:true}).click();
  await page.getByLabel('Display name',{exact:true}).fill('Early Backer');
  await page.getByLabel('Email',{exact:true}).fill(address);
  await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Create account ↗',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'check your inbox'})).toBeVisible();
  expect((await context.request.get('/api/account/profile')).status()).toBe(401);
  await page.goto(await deliver(address));
  await signIn(page,address);
  const profile=await(await context.request.get('/api/account/profile')).json();
  expect(profile.role).toBe('member');
  return profile;
}
async function createArtist(){
  const id=randomUUID(),spotify=id.replaceAll('-','').slice(0,22),name=`Browser Artist ${id.slice(0,8)}`;
  await db.query("INSERT INTO artists(id,slug,name,spotify_artist_id,status,synthetic) VALUES ($1,$1,$2,$3,'active',false)",[id,name,spotify]);
  const {rows:[clock]}=await db.query('SELECT clock_timestamp() AS now');
  const observedAt=new Date(clock.now.getTime()-60000).toISOString();
  const payload={artistId:id,sourceEventKey:randomUUID(),provider:'spotify',metric:'monthly_listeners',providerArtistId:spotify,listenerCount:'12345',
    sourceUrl:'https://open.spotify.com/artist/'+spotify,evidence:{reference:'fixture/backing-browser/'+id+'.png',sha256:'a'.repeat(64)},parserVersion:'manual-browser-fixture-v1',
    observedAt,fetchedAt:new Date(clock.now.getTime()-59000).toISOString(),sourceUpdatedAt:null};
  const response=await admin.request.post('/api/admin/listener-observations',{headers,data:payload});
  expect(response.status()).toBe(201);
  const observation=await response.json();
  expect(observation.status).toBe('accepted');expect(observation.snapshotId).toBeTruthy();
  expect(observation.validationVersion).toBe('spotify-listeners-v2');
  const {rows:[snapshot]}=await db.query('SELECT synthetic,status,listener_count::text,observed_at,accepted_at FROM listener_snapshots WHERE id=$1',[observation.snapshotId]);
  expect(snapshot).toMatchObject({synthetic:false,status:'accepted',listener_count:'12345'});
  expect(snapshot.observed_at.toISOString()).toBe(observedAt);
  return {id,name,observedAt,payload,snapshotId:observation.snapshotId,snapshotAcceptedAt:snapshot.accepted_at};
}
async function wallet(context){return (await(await context.request.get('/api/account/wallet')).json()).wallet;}
async function initialize(page){
  await page.getByRole('button',{name:'Initialize my server wallet ↗',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Your server wallet is ready.'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Queue server backing ↗',exact:true})).toBeVisible();
}
function row(page){return page.getByRole('listitem').filter({has:page.getByRole('heading',{name:artist.name,exact:true})});}
async function balances(page,available,reserved){
  const display=page.getByLabel('Server Credit balances',{exact:true});
  await expect(display.getByText('AVAILABLE CREDITS',{exact:true}).locator('..').locator('strong')).toHaveText(available+'CR');
  await expect(display.getByText('RESERVED CREDITS',{exact:true}).locator('..').locator('strong')).toHaveText(reserved+'CR');
}
async function noSettlement(userId){
  const {rows:[counts]}=await db.query(`SELECT
    (SELECT count(*)::int FROM settlements WHERE user_id=$1) settlements,
    (SELECT count(*)::int FROM position_lots WHERE user_id=$1) lots,
    (SELECT count(*)::int FROM receipt_events r JOIN position_lots l ON l.id=r.lot_id WHERE l.user_id=$1) receipts`,[userId]);
  expect(counts).toEqual({settlements:0,lots:0,receipts:0});
}
async function capture(page,info,state){
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath(`backing-${state}-${info.project.name}.png`),fullPage:true});
}
async function prepareBuy(page,amount='250.37'){
  await page.getByRole('combobox',{name:'Artist',exact:true}).selectOption(artist.id);
  await page.getByLabel('Credits to reserve',{exact:true}).fill(amount);
}

test.beforeAll(async({browser})=>{
  await db.query('TRUNCATE rate_limit,action_limits');
  admin=await browser.newContext({baseURL:base});
  const address=email();await register(admin,address);
  const {rows:[user]}=await db.query('SELECT id FROM "user" WHERE email=$1',[address]);
  await db.query("UPDATE members SET role='admin' WHERE user_id=$1",[user.id]);
  expect((await admin.request.post('/api/auth/sign-in/email',{headers,data:{email:address,password}})).ok()).toBeTruthy();
  expect((await(await admin.request.get('/api/account/profile')).json()).role).toBe('admin');
});
test.beforeEach(async({page,context})=>{
  await db.query('TRUNCATE rate_limit,action_limits');
  page.__backingErrors=[];page.on('pageerror',error=>page.__backingErrors.push(error.message));
  // Only external fonts are stubbed. Every wallet, order and observation uses Next HTTP.
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//,route=>route.fulfill({status:200,contentType:'text/css',body:''}));
  artist=await createArtist();
});
test.afterEach(async({page})=>expect(page.__backingErrors).toEqual([]));
test.afterAll(async()=>{await admin?.close();await db.end();});

test('admin intake deliberately rejects escaped NUL and lone surrogate JSON and preserves valid Unicode evidence (#57)',async()=>{
  const endpoint='/api/admin/listener-observations';
  const payload={...artist.payload,
    observedAt:new Date(Date.parse(artist.payload.observedAt)+1000).toISOString(),
    fetchedAt:new Date(Date.parse(artist.payload.fetchedAt)+1000).toISOString()};
  for(const [character,escaped] of [['\u0000','\\u0000'],['\ud800','\\ud800'],['\udc00','\\udc00']]){
    const sourceEventKey=randomUUID();
    const body=JSON.stringify({...payload,sourceEventKey,listenerCount:'bad'+character+'count'});
    expect(body).toContain(escaped);
    const response=await admin.request.post(endpoint,{headers:{...headers,'content-type':'application/json'},data:body});
    expect(response.status(),`escaped ${escaped} must be a deliberate client error`).toBe(400);
    expect(response.headers()['cache-control']).toContain('no-store');
    expect(await response.json()).toMatchObject({error:expect.stringContaining('documented JSON observation envelope')});
    expect((await db.query('SELECT count(*)::int n FROM listener_observations WHERE artist_id=$1 AND source_event_key=$2',[artist.id,sourceEventKey])).rows[0].n).toBe(0);
  }
  expect((await db.query('SELECT count(*)::int n FROM listener_snapshots WHERE artist_id=$1',[artist.id])).rows[0].n).toBe(1);
  const reference='fixture/é-音楽-🎵.png';
  const accepted=await admin.request.post(endpoint,{headers,data:{...payload,sourceEventKey:randomUUID(),evidence:{...payload.evidence,reference}}});
  expect(accepted.status()).toBe(201);
  const observation=await accepted.json();
  expect(observation).toMatchObject({status:'accepted',validationVersion:'spotify-listeners-v2',reasons:[]});
  expect(observation.snapshotId).toBeTruthy();
  const review=await admin.request.get(endpoint+'?id='+observation.id+'&artistId='+artist.id);
  expect(review.status()).toBe(200);
  expect(await review.json()).toMatchObject({payload:{evidence:{reference}}});
  expect((await db.query("SELECT evidence->>'reference' AS reference,synthetic FROM listener_snapshots WHERE id=$1",[observation.snapshotId])).rows).toEqual([{reference,synthetic:false}]);
});

test('verified member explicitly initializes, queues exact fractional Credits and cancels persisted backing without a receipt',async({page,context},info)=>{
  const member=await registerOnPage(page,context);
  expect(await wallet(context)).toBeNull();
  const before=await(await context.request.get('/api/account/backing')).json();
  expect(before.wallet).toBeNull();expect(before.orders).toEqual([]);
  await page.reload();
  await expect(page.getByRole('button',{name:'Initialize my server wallet ↗',exact:true})).toBeVisible();
  expect((await db.query('SELECT count(*)::int n FROM ledger_events WHERE user_id=$1',[member.id])).rows[0].n).toBe(0);
  await initialize(page);await balances(page,'1,000','0');
  expect(await wallet(context)).toEqual({availableCents:'100000',reservedCents:'0'});
  await prepareBuy(page);
  const accepted=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/account/orders'&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Queue server backing ↗',exact:true}).click();
  const response=await accepted;expect(response.status()).toBe(201);
  const result=await response.json(),order=result.order;
  expect(response.headers()['cache-control']).toContain('no-store');
  expect(response.request().postDataJSON()).toEqual({artistId:artist.id,amountCents:'25037',idempotencyKey:expect.any(String)});
  expect(order).toMatchObject({artistId:artist.id,status:'queued',side:'buy',amountCents:'25037',economyVersion:'backing-v1',settledAt:null,
    placement:{snapshotId:artist.snapshotId,listenerCount:'12345',observedAt:artist.observedAt}});
  const {rows:[stored]}=await db.query('SELECT accepted_at,earliest_cutoff,placement_snapshot_id FROM orders WHERE id=$1 AND user_id=$2',[order.id,member.id]);
  expect(stored.accepted_at.toISOString()).toBe(order.acceptedAt);
  expect(stored.earliest_cutoff.toISOString()).toBe(order.earliestCutoff);
  expect(Date.parse(order.acceptedAt)).toBeGreaterThanOrEqual(artist.snapshotAcceptedAt.getTime());
  expect(Date.parse(order.earliestCutoff)).toBe((Math.floor(Date.parse(order.acceptedAt)/43200000)+1)*43200000);
  await expect(row(page).getByText('QUEUED',{exact:true})).toBeVisible();
  await expect(row(page)).toContainText('250.37');await expect(row(page)).toContainText('12,345 monthly listeners');
  await expect(row(page)).toContainText('entry count is not fixed yet');
  await expect(row(page).getByText('Accepted by server',{exact:true}).locator('..').locator('time')).toHaveAttribute('datetime',order.acceptedAt);
  await expect(row(page).getByText('First eligible update',{exact:true}).locator('..').locator('time')).toHaveAttribute('datetime',order.earliestCutoff);
  await expect(row(page).getByText('Placement estimate',{exact:true}).locator('..').locator('time')).toHaveAttribute('datetime',artist.observedAt);
  await balances(page,'749.63','250.37');await noSettlement(member.id);
  await page.reload();await balances(page,'749.63','250.37');
  await expect(row(page).getByText('QUEUED',{exact:true})).toBeVisible();
  expect((await(await context.request.get('/api/account/backing')).json()).orders.map(item=>item.id)).toEqual([order.id]);
  await capture(page,info,'queued');
  await row(page).getByRole('button',{name:'Cancel backing for '+artist.name,exact:true}).click();
  await expect(row(page).getByText('CANCELLED',{exact:true})).toBeVisible();
  await balances(page,'1,000','0');await expect(row(page)).toContainText('no receipt earned');
  await expect(row(page).getByRole('button',{name:/Cancel backing/})).toHaveCount(0);
  await page.reload();await balances(page,'1,000','0');
  await expect(row(page).getByText('CANCELLED',{exact:true})).toBeVisible();
  await noSettlement(member.id);await capture(page,info,'cancelled');
  const retry=await context.request.post(`/api/account/orders/${order.id}/cancel`,{headers,data:{}});
  expect(retry.status()).toBe(200);expect((await retry.json()).cancelled).toBe(false);
  expect(await wallet(context)).toEqual({availableCents:'100000',reservedCents:'0'});
  expect((await db.query('SELECT kind,available_delta::text,reserved_delta::text FROM ledger_events WHERE user_id=$1 ORDER BY created_at,id',[member.id])).rows).toEqual([
    {kind:'starting_grant',available_delta:'100000',reserved_delta:'0'},
    {kind:'buy_reserve',available_delta:'-25037',reserved_delta:'25037'},
    {kind:'buy_cancel',available_delta:'25037',reserved_delta:'-25037'},
  ]);
  expect((await db.query('SELECT status,amount_cents::text FROM cash_reservations WHERE order_id=$1',[order.id])).rows).toEqual([{status:'released',amount_cents:'25037'}]);
});

test('real APIs isolate member orders and reject injected authority, invalid amounts, origins, cursors and oversized bodies',async({page,context,browser})=>{
  const member=await registerOnPage(page,context);
  const other=await browser.newContext({baseURL:base}),anonymous=await browser.newContext({baseURL:base});
  try{
    await register(other,email());
    const otherMember=await(await other.request.get('/api/account/profile')).json();
    const intent=buy(artist.id,'101');
    for(const path of ['/api/account/backing','/api/account/orders/'+randomUUID()])expect((await anonymous.request.get(path)).status()).toBe(401);
    expect((await anonymous.request.post('/api/account/orders',{headers,data:intent})).status()).toBe(401);
    expect((await context.request.post('/api/account/orders',{headers,data:intent})).status()).toBe(409);
    expect(await wallet(context)).toBeNull();
    await initialize(page);
    const write=data=>context.request.post('/api/account/orders',{headers,data});
    expect((await context.request.post('/api/account/orders',{headers:{origin:'https://attacker.invalid'},data:intent})).status()).toBe(403);
    expect((await context.request.post('/api/account/orders',{data:intent})).status()).toBe(403);
    for(const extra of [{userId:otherMember.id},{accountId:otherMember.id},{amount:1},{price:'0.01'},{listenerCount:'1'},{acceptedAt:'2000-01-01T00:00:00.000Z'},{earliestCutoff:'2000-01-01T12:00:00.000Z'}]){
      expect((await write({...intent,...extra})).status(),JSON.stringify(extra)).toBe(400);
    }
    for(const amountCents of [101,'0','99','1.01','0101','1e2','9223372036854775808'])expect((await write({...intent,amountCents})).status(),String(amountCents)).toBe(400);
    expect((await write({...intent,amountCents:'100001'})).status()).toBe(422);
    expect((await write({...intent,artistId:randomUUID()})).status()).toBe(404);
    expect((await write({...intent,padding:'x'.repeat(4096)})).status()).toBe(413);
    expect((await context.request.post('/api/account/orders',{headers:{...headers,'content-type':'application/json'},data:'{'})).status()).toBe(400);
    for(const cursor of ['%', 'x'.repeat(513),Buffer.from(JSON.stringify(['not-a-date','order'])).toString('base64url')]){
      expect((await context.request.get('/api/account/backing?cursor='+encodeURIComponent(cursor))).status()).toBe(400);
    }
    expect((await db.query('SELECT count(*)::int n FROM orders WHERE user_id=$1',[member.id])).rows[0].n).toBe(0);
    const placed=await write(intent);expect(placed.status()).toBe(201);const {order}=await placed.json();
    const detail=await context.request.get('/api/account/orders/'+order.id);expect(detail.status()).toBe(200);expect(await detail.json()).toMatchObject({id:order.id,amountCents:'101'});
    expect((await other.request.get('/api/account/orders/'+order.id)).status()).toBe(404);
    expect((await other.request.post(`/api/account/orders/${order.id}/cancel`,{headers,data:{}})).status()).toBe(404);
    expect((await anonymous.request.post(`/api/account/orders/${order.id}/cancel`,{headers,data:{}})).status()).toBe(401);
    const otherDesk=await(await other.request.get('/api/account/backing?userId='+member.id)).json();
    expect(otherDesk.orders).toEqual([]);expect(otherDesk.wallet).toBeNull();
    expect((await(await context.request.get('/api/account/backing?userId='+otherMember.id)).json()).orders.map(item=>item.id)).toEqual([order.id]);
    const cancel=data=>context.request.post(`/api/account/orders/${order.id}/cancel`,{headers,data});
    expect((await context.request.post(`/api/account/orders/${order.id}/cancel`,{headers:{origin:'https://attacker.invalid'},data:{}})).status()).toBe(403);
    for(const data of [{userId:otherMember.id},{amountCents:'1'},{price:'1'},{cancelledAt:'2000-01-01T00:00:00.000Z'},[]])expect((await cancel(data)).status()).toBe(400);
    expect((await cancel({padding:'x'.repeat(4096)})).status()).toBe(413);
    const replay=await write(intent);expect(replay.status()).toBe(200);expect((await replay.json()).order.id).toBe(order.id);
    expect((await write({...intent,amountCents:'102'})).status()).toBe(409);
    expect(await wallet(context)).toEqual({availableCents:'99899',reservedCents:'101'});
    expect((await cancel({})).status()).toBe(200);expect(await wallet(context)).toEqual({availableCents:'100000',reservedCents:'0'});
    await noSettlement(member.id);
  }finally{await other.close();await anonymous.close();}
});

test('lost response after real POST commit survives reload and retries exactly one order and reservation',async({page,context},info)=>{
  const member=await registerOnPage(page,context);await initialize(page);await prepareBuy(page,'17.43');
  let intent,committed;
  // Fetch the real endpoint first, wait for its committed 201, then lose only its response.
  await page.route(base+'/api/account/orders',async route=>{
    intent=route.request().postDataJSON();
    const response=await route.fetch({maxRetries:0});
    expect(response.status()).toBe(201);committed=await response.json();
    await route.abort('failed');
  },{times:1});
  await page.getByRole('button',{name:'Queue server backing ↗',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'We could not confirm whether your order was accepted.'})).toBeVisible();
  expect(intent).toEqual({artistId:artist.id,amountCents:'1743',idempotencyKey:expect.any(String)});
  expect(committed.order.status).toBe('queued');
  await page.reload();await balances(page,'982.57','17.43');
  await expect(row(page).getByText('QUEUED',{exact:true})).toBeVisible();
  await expect(page.getByRole('combobox',{name:'Artist',exact:true})).toBeDisabled();
  await expect(page.getByLabel('Credits to reserve',{exact:true})).toHaveValue('17.43');
  const replayed=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/account/orders'&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Retry this same backing ↗',exact:true}).click();
  const response=await replayed;expect(response.request().postDataJSON()).toEqual(intent);expect(response.status()).toBe(200);
  const result=await response.json();expect(result.created).toBe(false);expect(result.order.id).toBe(committed.order.id);
  await expect(page.getByRole('button',{name:'Queue server backing ↗',exact:true})).toBeVisible();
  await expect(page.getByRole('combobox',{name:'Artist',exact:true})).toBeEnabled();await expect(row(page)).toHaveCount(1);
  await balances(page,'982.57','17.43');
  const {rows:[proof]}=await db.query(`SELECT
    (SELECT count(*)::int FROM orders WHERE user_id=$1) orders,
    (SELECT count(*)::int FROM orders WHERE user_id=$1 AND request_key=$2) same_key_orders,
    (SELECT count(*)::int FROM cash_reservations WHERE user_id=$1) reservations,
    (SELECT count(*)::int FROM ledger_events WHERE user_id=$1 AND kind='buy_reserve') reserve_events`,[member.id,intent.idempotencyKey]);
  expect(proof).toEqual({orders:1,same_key_orders:1,reservations:1,reserve_events:1});
  expect((await db.query('SELECT order_id,status,amount_cents::text FROM cash_reservations WHERE user_id=$1',[member.id])).rows).toEqual([
    {order_id:committed.order.id,status:'held',amount_cents:'1743'},
  ]);
  expect((await db.query("SELECT order_id,available_delta::text,reserved_delta::text FROM ledger_events WHERE user_id=$1 AND kind='buy_reserve'",[member.id])).rows).toEqual([
    {order_id:committed.order.id,available_delta:'-1743',reserved_delta:'1743'},
  ]);
  await noSettlement(member.id);await capture(page,info,'confirmed-retry');
});

test('request dropped before the server unlocks only after a paused artist retry proves intent absent',async({page,context})=>{
  const member=await registerOnPage(page,context);await initialize(page);await prepareBuy(page,'1.01');
  let intent;
  await page.route(base+'/api/account/orders',async route=>{intent=route.request().postDataJSON();await route.abort('failed');},{times:1});
  await page.getByRole('button',{name:'Queue server backing ↗',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'We could not confirm whether your order was accepted.'})).toBeVisible();
  expect((await db.query('SELECT count(*)::int n FROM orders WHERE user_id=$1',[member.id])).rows[0].n).toBe(0);
  await db.query("UPDATE artists SET status='suspended' WHERE id=$1",[artist.id]);
  await page.reload();
  await expect(page.getByRole('combobox',{name:'Artist',exact:true})).toBeDisabled();
  const retried=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/account/orders'&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Retry this same backing ↗',exact:true}).click();
  const response=await retried;expect(response.request().postDataJSON()).toEqual(intent);expect(response.status()).toBe(422);
  expect(await response.json()).toMatchObject({code:'ineligible',intentAbsent:true});
  await expect(page.getByRole('button',{name:'Retry this same backing ↗',exact:true})).toHaveCount(0);
  await expect(page.getByRole('status').filter({hasText:'This artist is not accepting new backing.'})).toBeVisible();
  expect(await page.evaluate(key=>sessionStorage.getItem(key),'first-press:pending-server-buy:'+member.id)).toBeNull();
  expect(await wallet(context)).toEqual({availableCents:'100000',reservedCents:'0'});
  await balances(page,'1,000','0');
  expect((await db.query('SELECT count(*)::int n FROM orders WHERE user_id=$1',[member.id])).rows[0].n).toBe(0);
  expect((await db.query('SELECT count(*)::int n FROM cash_reservations WHERE user_id=$1',[member.id])).rows[0].n).toBe(0);
  expect((await db.query("SELECT count(*)::int n FROM ledger_events WHERE user_id=$1 AND kind='buy_reserve'",[member.id])).rows[0].n).toBe(0);
  await noSettlement(member.id);
});

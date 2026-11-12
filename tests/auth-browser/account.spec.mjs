import {test,expect} from 'playwright/test';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
const base='http://127.0.0.1:3101',db=new pg.Pool({connectionString:process.env.TEST_AUTH_DATABASE_URL});
const password='isolated-browser-password-123';
const email=()=>`fixture-${randomUUID()}@example.invalid`;
async function invite(address){await db.query("INSERT INTO beta_invites(email,created_by,expires_at) VALUES ($1,'browser-fixture',now()+interval '1 day')",[address]);}
async function deliver(address,purpose){
  for(let i=0;i<30;i++){
    const {rows:[mail]}=await db.query('SELECT status FROM mail_outbox WHERE recipient=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1',[address,purpose]);
    if(mail?.status==='sent')break;
    execFileSync(process.execPath,['scripts/auth/mail-worker.mjs','--once'],{env:{...process.env,DATABASE_URL:process.env.TEST_AUTH_DATABASE_URL},stdio:'pipe'});
  }
  const {rows:[mail]}=await db.query('SELECT status,body FROM mail_outbox WHERE recipient=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1',[address,purpose]);expect(mail).toEqual({status:'sent',body:null});
  const messages=await(await fetch('http://127.0.0.1:8026/messages')).json();
  const message=messages.filter(x=>x.includes(address)&&x.includes(purpose==='reset'?'Reset your':'Verify your')).at(-1);expect(message).toBeTruthy();
  return message.match(/http:\/\/127\.0\.0\.1:3101\/[^\s]+/)[0];
}
async function register(context,address){
  await invite(address);
  expect((await context.request.post('/api/auth/sign-up/email',{headers:{origin:base},data:{email:address,password,name:'Fixture Member',callbackURL:base+'/account'}})).ok()).toBeTruthy();
  expect((await context.request.get(await deliver(address,'verification'))).ok()).toBeTruthy();
  expect((await context.request.post('/api/auth/sign-in/email',{headers:{origin:base},data:{email:address,password}})).ok()).toBeTruthy();
}
test.beforeEach(async({context,page})=>{
  await db.query('TRUNCATE rate_limit,action_limits');
  page.__errors=[];page.on('pageerror',e=>page.__errors.push(e.message));
  await context.route('https://fonts.googleapis.com/**',route=>route.fulfill({status:200,contentType:'text/css',body:''}));
});
test.afterEach(async({page})=>expect(page.__errors).toEqual([]));
test.afterAll(async()=>{await db.end();});

test('invited member signs up, verifies delivered email, signs in and updates their profile',async({page,context},info)=>{
  const address=email();await invite(address);await page.goto('/account');
  await page.getByRole('button',{name:'Have an invitation? Create account'}).click();
  await page.getByLabel('Display name',{exact:true}).fill('Early Ears');
  await page.getByLabel('Email',{exact:true}).fill(address);await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Create account ↗',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'check your inbox'})).toBeVisible();
  expect((await context.request.get('/api/account/profile')).status()).toBe(401);
  await page.goto(await deliver(address,'verification'));
  await page.getByLabel('Email',{exact:true}).fill(address);await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Sign in ↗',exact:true}).click();
  await expect(page.getByRole('heading',{name:/Good to see you/})).toBeVisible();
  await page.getByLabel('Display name',{exact:true}).fill('On Record');await page.getByRole('button',{name:'Save display name ↗'}).click();
  await expect(page.getByRole('status').filter({hasText:'Display name saved.'})).toBeVisible();
  const profile=await(await context.request.get('/api/account/profile')).json();expect(profile.name).toBe('On Record');expect(profile.role).toBe('member');
  expect((await(await context.request.get('/api/account/wallet')).json()).wallet).toBeNull();
  const cookie=(await context.cookies()).find(c=>c.name==='better-auth.session_token');expect(cookie.httpOnly).toBe(true);expect(cookie.sameSite).toBe('Lax');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('connected-account.png'),fullPage:true});
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('heading',{name:'Your ears. Your account.'})).toBeVisible();
  expect((await context.request.get('/api/account/profile')).status()).toBe(401);
});

test('password reset arrives through SMTP, changes the password and invalidates the old session',async({page,context})=>{
  const address=email();await register(context,address);
  const old=await context.browser().newContext({baseURL:base});
  expect((await old.request.post('/api/auth/sign-in/email',{headers:{origin:base},data:{email:address,password}})).ok()).toBeTruthy();
  expect((await old.request.get('/api/account/profile')).status()).toBe(200);
  await context.request.post('/api/auth/sign-out',{headers:{origin:base},data:{}});
  await page.goto('/account');await page.getByRole('button',{name:'Forgot password?',exact:true}).click();
  await page.getByLabel('Email',{exact:true}).fill(address);await page.getByRole('button',{name:'Send reset link ↗'}).click();
  await expect(page.getByRole('status').filter({hasText:'reset link will arrive'})).toBeVisible();
  await page.goto(await deliver(address,'reset'));
  await page.getByLabel('New password',{exact:true}).fill('new-browser-password-123');await page.getByLabel('Confirm password',{exact:true}).fill('new-browser-password-123');
  await page.getByRole('button',{name:'Set password ↗'}).click();await expect(page.getByRole('heading',{name:'Back in rotation.'})).toBeVisible();
  expect(page.url()).not.toContain('token=');
  expect((await old.request.get('/api/account/profile')).status()).toBe(401);await old.close();
  await page.getByRole('link',{name:'Sign in ↗',exact:true}).click();await page.getByLabel('Email',{exact:true}).fill(address);await page.getByLabel('Password',{exact:true}).fill('new-browser-password-123');
  await page.getByRole('button',{name:'Sign in ↗',exact:true}).click();await expect(page.getByRole('heading',{name:/Good to see you/})).toBeVisible();
});

test('owned APIs reject another member’s order, role injection, cross-origin writes and non-admin invites',async({context,browser})=>{
  const address=email();await register(context,address);
  const other=await browser.newContext({baseURL:base});const otherEmail=email();await register(other,otherEmail);
  const {rows:[a]}=await db.query('SELECT id FROM "user" WHERE email=$1',[address]);
  expect((await context.request.post('/api/account/wallet',{headers:{origin:base},data:{}})).status()).toBe(201);
  const now=new Date(),observed=new Date(now.getTime()-60000),accepted=new Date(now.getTime()-30000),cutoff=new Date((Math.floor(now.getTime()/43200000)+1)*43200000);
  const snapshot=randomUUID(),order=randomUUID();
  await db.query("INSERT INTO artists(id,slug,name,spotify_artist_id,status) VALUES ('auth-fixture-artist','auth-fixture-artist','Fixture Artist','3333333333333333333333','active') ON CONFLICT DO NOTHING");
  await db.query(`INSERT INTO listener_snapshots(id,artist_id,status,listener_count,source_url,source_event_key,evidence,parser_version,observed_at,fetched_at,accepted_at,reviewed_by)
    VALUES ($1,'auth-fixture-artist','accepted',10000,'https://example.invalid',$1,'{}','fixture',$2,$2,$3,'fixture')`,[snapshot,observed,accepted]);
  await db.query(`INSERT INTO orders(id,user_id,artist_id,side,amount_cents,request_key,request_hash,placement_snapshot_id,accepted_at,earliest_cutoff)
    VALUES ($1,$2,'auth-fixture-artist','buy',100,$1,repeat('a',64),$3,$4,$5)`,[order,a.id,snapshot,now,cutoff]);
  expect((await context.request.get('/api/account/orders/'+order)).status()).toBe(200);
  expect((await other.request.get('/api/account/orders/'+order)).status()).toBe(404);
  expect((await(await context.request.get('/api/account/wallet?userId=someone-else')).json()).wallet.availableCents).toBe('100000');
  expect((await(await other.request.get('/api/account/wallet?userId='+a.id)).json()).wallet).toBeNull();
  expect((await other.request.patch('/api/account/profile',{headers:{origin:base},data:{name:'stolen',userId:a.id,role:'admin'}})).status()).toBe(400);
  expect((await context.request.patch('/api/account/profile',{headers:{origin:'https://attacker.invalid'},data:{name:'stolen'}})).status()).toBe(403);
  expect((await other.request.post('/api/admin/invites',{headers:{origin:base},data:{email:email(),reason:'fixture'}})).status()).toBe(403);
  await db.query("UPDATE members SET status='suspended' WHERE user_id=$1",[a.id]);expect((await context.request.get('/api/account/profile')).status()).toBe(401);
  const {rows:[b]}=await db.query('SELECT id FROM "user" WHERE email=$1',[otherEmail]);
  await db.query("UPDATE members SET role='admin' WHERE user_id=$1",[b.id]);
  expect((await other.request.get('/api/account/profile')).status()).toBe(401);
  expect((await other.request.post('/api/auth/sign-in/email',{headers:{origin:base},data:{email:otherEmail,password}})).ok()).toBeTruthy();
  const invited=email();expect((await other.request.post('/api/admin/invites',{headers:{origin:base},data:{email:invited,reason:'Approved fixture invite'}})).status()).toBe(201);
  expect((await db.query('SELECT created_by FROM beta_invites WHERE email=$1',[invited])).rows[0].created_by).toBe(b.id);
  expect((await db.query('SELECT count(*)::int AS n FROM mail_outbox WHERE recipient=$1',[invited])).rows[0].n).toBe(0);
  await other.close();
});

test('server wallet grant is fixed, exactly once and cannot target another member or import demo Credits',async({context,browser})=>{
  const address=email();await register(context,address);
  const other=await browser.newContext({baseURL:base});const otherEmail=email();await register(other,otherEmail);
  const {rows:[b]}=await db.query('SELECT id FROM "user" WHERE email=$1',[otherEmail]);
  expect((await context.request.post('/api/account/wallet',{headers:{origin:'https://attacker.invalid'},data:{}})).status()).toBe(403);
  for(const data of [{amountCents:'999999999'},{credits:999999999},{userId:b.id}])expect((await context.request.post('/api/account/wallet',{headers:{origin:base},data})).status()).toBe(400);
  const grants=await Promise.all(Array.from({length:5},()=>context.request.post('/api/account/wallet',{headers:{origin:base},data:{}})));
  expect(grants.filter(x=>x.status()===201)).toHaveLength(1);expect(grants.filter(x=>x.status()===200)).toHaveLength(4);
  const values=await Promise.all(grants.map(x=>x.json()));for(const value of values)expect(value.wallet).toEqual({availableCents:'100000',reservedCents:'0'});
  expect(new Set(values.map(x=>x.startingGrantEventId)).size).toBe(1);
  expect((await(await other.request.get('/api/account/wallet')).json()).wallet).toBeNull();
  expect((await context.request.get('/api/admin/ledger')).status()).toBe(403);
  await db.query("UPDATE members SET role='admin' WHERE user_id=$1",[b.id]);
  expect((await other.request.post('/api/auth/sign-in/email',{headers:{origin:base},data:{email:otherEmail,password}})).ok()).toBeTruthy();
  const profile=await(await context.request.get('/api/account/profile')).json();
  const diagnostic=await(await other.request.get('/api/admin/ledger?userId='+profile.id)).json();
  expect(diagnostic.ok).toBe(true);expect(diagnostic.ledger.startingGrantCount).toBe('1');expect(diagnostic.ledger.eventCount).toBe('1');expect(diagnostic.heldReservationCents).toBe('0');
  await other.close();
});

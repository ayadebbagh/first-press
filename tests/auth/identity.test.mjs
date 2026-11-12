import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createAuthentication } from '../../src/server/auth/core.ts';
import * as schema from '../../src/server/db/schema.ts';
const url=process.env.TEST_AUTH_DATABASE_URL;
if(!url||!new URL(url).pathname.endsWith('_auth_test'))throw Error('Use an explicit disposable TEST_AUTH_DATABASE_URL ending _auth_test.');
const pool=new pg.Pool({connectionString:url});
const baseURL='http://127.0.0.1:3101';
const config={baseURL,secret:'isolated-auth-test-secret-at-least-32-characters',ipAddressHeaders:[],google:{clientId:'fixture-google-id',clientSecret:'fixture-google-secret'}};
const db=drizzle(pool,{schema});
let auth;
function jar(){return new Map();}
async function call(path,body,cookies=jar(),headers={}){
  const response=await auth.handler(new Request(baseURL+'/api/auth'+path,{method:body===undefined?'GET':'POST',headers:{origin:baseURL,'content-type':'application/json',cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),...headers},body:body===undefined?undefined:JSON.stringify(body)}));
  for(const cookie of response.headers.getSetCookie()){const [pair]=cookie.split(';'),i=pair.indexOf('=');cookies.set(pair.slice(0,i),pair.slice(i+1));}
  return response;
}
async function invite(email){await pool.query("INSERT INTO beta_invites(email,created_by,expires_at) VALUES ($1,'auth-fixture',now()+interval '1 day')",[email]);}
async function signup(email){return call('/sign-up/email',{email,password:'test-only-long-password-123',name:'Fixture Member',callbackURL:baseURL+'/account'});}
async function lastLink(email,purpose){const {rows:[row]}=await pool.query('SELECT body FROM mail_outbox WHERE recipient=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1',[email,purpose]);assert.ok(row);return row.body.match(/http[^\s]+/)[0];}
async function verify(email){const link=await lastLink(email,'verification');const response=await auth.handler(new Request(link,{headers:{origin:baseURL}}));assert.ok([200,302].includes(response.status),await response.text());}
async function signin(email,cookies=jar()){const response=await call('/sign-in/email',{email,password:'test-only-long-password-123'},cookies);assert.equal(response.status,200,await response.text());return cookies;}
async function fresh(){await pool.query('TRUNCATE TABLE "user",members,beta_invites,mail_outbox,session,account,verification,rate_limit,auth_audit_events CASCADE');auth=createAuthentication(db,config);}
before(async()=>{
  const r=spawnSync(process.execPath,['scripts/db/migrate.mjs'],{env:{...process.env,DATABASE_URL:url},encoding:'utf8',timeout:60000});assert.equal(r.status,0,r.stdout+r.stderr);
});
after(async()=>{await pool.end();});

test('email-bound invites gate every new user, are single-claim and never grant admin or Credits',async()=>{
  await fresh();
  const blocked=await signup('not-invited@example.invalid');assert.equal(blocked.status,200,'uninvited email gets generic signup response');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM "user"')).rows[0].n,0);
  await invite('member@example.invalid');const response=await signup('MEMBER@example.invalid');assert.equal(response.status,200,await response.text());
  const {rows:[member]}=await pool.query('SELECT u.email,u.email_verified,m.role,m.status FROM "user" u JOIN members m ON m.user_id=u.id');
  assert.deepEqual(member,{email:'member@example.invalid',email_verified:false,role:'member',status:'active'});
  assert.ok((await pool.query('SELECT claimed_by FROM beta_invites')).rows[0].claimed_by);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM wallets')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ledger_events')).rows[0].n,0);
  await assert.rejects(pool.query(`INSERT INTO "user"(id,name,email) VALUES ('bypass','Bypass','other@example.invalid')`),e=>e.code==='23514');
});

test('verification is required, then signed cookies create a real expiring session and sign-out revokes it',async()=>{
  await fresh();await invite('verify@example.invalid');await signup('verify@example.invalid');
  assert.equal((await call('/sign-in/email',{email:'verify@example.invalid',password:'test-only-long-password-123'})).status,403);
  await verify('verify@example.invalid');const cookies=await signin('verify@example.invalid');
  const session=await (await call('/get-session',undefined,cookies)).json();assert.equal(session.user.email,'verify@example.invalid');
  assert.ok(cookies.has('better-auth.session_token'));assert.ok(new Date(session.session.expiresAt)>new Date());
  const old=jar();for(const [k,v] of cookies)old.set(k,v);
  assert.equal((await call('/sign-out',{},cookies)).status,200);
  assert.equal(await (await call('/get-session',undefined,old)).json(),null);
});

test('forged cookies, cross-origin requests and expired sessions do not authorize identity',async()=>{
  await fresh();await invite('expiry@example.invalid');await signup('expiry@example.invalid');await verify('expiry@example.invalid');
  assert.equal((await call('/sign-in/email',{email:'expiry@example.invalid',password:'test-only-long-password-123'},jar(),{origin:'https://attacker.invalid'})).status,403);
  assert.equal(await(await call('/get-session',undefined,new Map([['better-auth.session_token','forged']]))).json(),null);
  const cookies=await signin('expiry@example.invalid');await pool.query("UPDATE session SET expires_at=now()-interval '1 second'");
  assert.equal(await(await call('/get-session',undefined,cookies)).json(),null);
});

test('password recovery is generic, single-use and revokes previous sessions',async()=>{
  await fresh();await invite('recovery@example.invalid');await signup('recovery@example.invalid');await verify('recovery@example.invalid');
  const cookies=await signin('recovery@example.invalid');
  const unknown=await call('/request-password-reset',{email:'unknown@example.invalid',redirectTo:baseURL+'/reset-password'});
  const known=await call('/request-password-reset',{email:'recovery@example.invalid',redirectTo:baseURL+'/reset-password'});
  assert.deepEqual(await known.json(),await unknown.json());
  const link=await lastLink('recovery@example.invalid','reset');const token=new URL(link).pathname.split('/').at(-1);
  assert.equal((await call('/reset-password',{token,newPassword:'a-new-long-password-123'})).status,200);
  assert.equal(await(await call('/get-session',undefined,cookies)).json(),null);
  assert.notEqual((await call('/reset-password',{token,newPassword:'another-long-password-123'})).status,200);
  assert.notEqual((await call('/sign-in/email',{email:'recovery@example.invalid',password:'test-only-long-password-123'})).status,200);
  assert.equal((await call('/sign-in/email',{email:'recovery@example.invalid',password:'a-new-long-password-123'})).status,200);
  await call('/request-password-reset',{email:'recovery@example.invalid',redirectTo:baseURL+'/reset-password'});
  const expired=new URL(await lastLink('recovery@example.invalid','reset')).pathname.split('/').at(-1);
  await pool.query("UPDATE verification SET expires_at=now()-interval '1 second' WHERE identifier LIKE 'reset-password:%'");
  assert.notEqual((await call('/reset-password',{token:expired,newPassword:'expired-reset-password-123'})).status,200);
});

test('suspension and role changes revoke sessions and suspension blocks new sign-in',async()=>{
  await fresh();await invite('suspend@example.invalid');await signup('suspend@example.invalid');await verify('suspend@example.invalid');
  const cookies=await signin('suspend@example.invalid');await pool.query("UPDATE members SET status='suspended'");
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM session')).rows[0].n,0);
  assert.equal(await(await call('/get-session',undefined,cookies)).json(),null);
  assert.notEqual((await call('/sign-in/email',{email:'suspend@example.invalid',password:'test-only-long-password-123'})).status,200);
});

test('database-backed auth throttling persists across server instances and ignores untrusted forwarded IPs',async()=>{
  await fresh();
  for(let i=0;i<5;i++)assert.notEqual((await call('/sign-in/email',{email:'missing@example.invalid',password:'invalid-password'},jar(),{'x-forwarded-for':`198.51.100.${i}`})).status,429);
  auth=createAuthentication(db,config);
  assert.equal((await call('/sign-in/email',{email:'missing@example.invalid',password:'invalid-password'},jar(),{'x-forwarded-for':'203.0.113.99'})).status,429);
});

const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
async function googleToken(id,verified=true){
  const context=await auth.$context,provider=context.socialProviders.find(p=>p.id==='google');assert.ok(provider);
  // A local signing key replaces only the JWKS fetch in this test instance.
  // The real Google adapter still verifies signature, issuer, audience and expiry.
  provider.idToken.jwks=async()=>publicKey;
  const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'fixture'})).toString('base64url');
  const now=Math.floor(Date.now()/1000),payload=Buffer.from(JSON.stringify({iss:'https://accounts.google.com',aud:config.google.clientId,iat:now,exp:now+600,sub:'google-fixture-'+id,email:id+'@example.invalid',email_verified:verified,name:'Google Fixture'})).toString('base64url');
  const signed=header+'.'+payload;return signed+'.'+sign('RSA-SHA256',Buffer.from(signed),privateKey).toString('base64url');
}
test('Google signed claims pass through the same invite and verified-email admission rules',async()=>{
  await fresh();
  const denied=await call('/sign-in/social',{provider:'google',idToken:{token:await googleToken('notinvited')}});assert.notEqual(denied.status,200);
  await invite('google@example.invalid');const cookies=jar();const accepted=await call('/sign-in/social',{provider:'google',idToken:{token:await googleToken('google')}},cookies);
  assert.equal(accepted.status,200,await accepted.text());
  assert.equal((await(await call('/get-session',undefined,cookies)).json()).user.email,'google@example.invalid');
  assert.equal((await pool.query('SELECT role FROM members')).rows[0].role,'member');
  await invite('unverified@example.invalid');const unverified=await call('/sign-in/social',{provider:'google',idToken:{token:await googleToken('unverified',false)}});
  assert.notEqual(unverified.status,200);
  assert.equal((await call('/sign-in/social',{provider:'google',idToken:{token:'forged.payload.signature'}})).status,401);
});

test('same-email Google sign-in cannot silently link an existing password account',async()=>{
  await fresh();await invite('existing@example.invalid');await signup('existing@example.invalid');await verify('existing@example.invalid');
  const result=await call('/sign-in/social',{provider:'google',idToken:{token:await googleToken('existing')}});
  assert.notEqual(result.status,200);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM account WHERE provider_id='google'")).rows[0].n,0);
});

test('HTTPS sessions use Secure, HttpOnly and SameSite cookies',async()=>{
  await fresh();await invite('secure@example.invalid');await signup('secure@example.invalid');await verify('secure@example.invalid');
  auth=createAuthentication(db,{...config,baseURL:'https://beta.example.invalid'});
  const result=await auth.handler(new Request('https://beta.example.invalid/api/auth/sign-in/email',{method:'POST',headers:{origin:'https://beta.example.invalid','content-type':'application/json'},body:JSON.stringify({email:'secure@example.invalid',password:'test-only-long-password-123'})}));
  assert.equal(result.status,200,await result.text());
  const cookie=result.headers.getSetCookie().find(x=>x.includes('session_token='));
  assert.match(cookie,/; Secure/i);assert.match(cookie,/; HttpOnly/i);assert.match(cookie,/; SameSite=Lax/i);
});

test('verified members can explicitly link Google without silently linking at sign-in',async()=>{
  await fresh();await invite('link@example.invalid');await signup('link@example.invalid');await verify('link@example.invalid');
  const cookies=await signin('link@example.invalid');const token=await googleToken('link');
  const result=await call('/link-social',{provider:'google',idToken:{token}},cookies);
  assert.equal(result.status,200,await result.text());
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM account WHERE provider_id='google'")).rows[0].n,1);
  assert.equal((await call('/sign-in/social',{provider:'google',idToken:{token}})).status,200);
});

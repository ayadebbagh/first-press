import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema.ts';
import { ECONOMY_VERSION, INITIAL_CREDITS_CENTS, MAX_CENTS } from '../../domain/backing-policy.ts';

export type LedgerDatabase = NodePgDatabase<typeof schema>;
export type LedgerTransaction = Parameters<Parameters<LedgerDatabase['transaction']>[0]>[0];
export class LedgerError extends Error {
  readonly code: 'ineligible'|'uninitialized'|'invalid'|'insufficient'|'overflow'|'conflict'|'drift';
  constructor(code: LedgerError['code'], message: string) { super(message); this.code=code; }
}
type Balance = { availableCents: bigint; reservedCents: bigint };
type OrderKind = 'buy_reserve'|'buy_cancel'|'buy_settle'|'sell_settle';
export interface OrderMovement { kind: OrderKind; orderId: string; idempotencyKey: string; amountCents: bigint }

function bounded(value: bigint) {
  if(typeof value!=='bigint'||value<0n)throw new LedgerError('invalid','Use nonnegative integer centi-Credits.');
  if(value>MAX_CENTS)throw new LedgerError('overflow','Credit amount exceeds the supported range.');
}
function nextBalance(balance: Balance, availableDelta: bigint, reservedDelta: bigint): Balance {
  const availableCents=balance.availableCents+availableDelta,reservedCents=balance.reservedCents+reservedDelta;
  if(availableCents<0n||reservedCents<0n)throw new LedgerError('insufficient','Insufficient available or reserved Credits.');
  bounded(availableCents);bounded(reservedCents);bounded(availableCents+reservedCents);
  return { availableCents,reservedCents };
}
// Future order services take the artist admission lock first, then use this same
// member -> user -> wallet -> order lock order. No source/network work under locks.
async function lockEligibleOwner(tx: LedgerTransaction, userId: string) {
  const [member]=await tx.select().from(schema.members).where(eq(schema.members.userId,userId)).for('update');
  const [user]=await tx.select().from(schema.user).where(eq(schema.user.id,userId)).for('update');
  const demo=await tx.select().from(schema.databaseIdentity).where(eq(schema.databaseIdentity.purpose,'demo'));
  if(!member||member.status!=='active'||!user?.emailVerified||demo.length)throw new LedgerError('ineligible','An active verified member account is required.');
}
async function lockedWallet(tx: LedgerTransaction,userId: string) {
  const [wallet]=await tx.select().from(schema.wallets).where(eq(schema.wallets.userId,userId)).for('update');
  if(!wallet)throw new LedgerError('uninitialized','Initialize the server wallet first.');
  const sums=await tx.execute(sql`SELECT coalesce(sum(available_delta::numeric),0)::text AS available,
    coalesce(sum(reserved_delta::numeric),0)::text AS reserved FROM ledger_events WHERE user_id=${userId}`);
  if(wallet.availableCents!==BigInt(String(sums.rows[0].available))||wallet.reservedCents!==BigInt(String(sums.rows[0].reserved)))throw new LedgerError('drift','Wallet accounting needs review.');
  return wallet;
}
// Internal owning services call this after the artist lock and before any order
// lock. Holding only an order before entering the ledger can deadlock admission.
export async function lockBackingAccount(tx: LedgerTransaction,userId: string) {
  await lockEligibleOwner(tx,userId);
  return lockedWallet(tx,userId);
}
async function append(tx: LedgerTransaction,userId: string,balance: Balance,event: {
  kind: typeof schema.ledgerEvents.$inferInsert.kind; idempotencyKey: string;
  orderId?: string;artistId?: string;availableDelta: bigint;reservedDelta: bigint;
}) {
  const next=nextBalance(balance,event.availableDelta,event.reservedDelta);
  const [entry]=await tx.insert(schema.ledgerEvents).values({id:randomUUID(),userId,...event}).returning({id:schema.ledgerEvents.id});
  await tx.update(schema.wallets).set({...next,updatedAt:new Date()}).where(eq(schema.wallets.userId,userId));
  return { wallet:next,eventId:entry.id };
}

export async function initializeWallet(db: LedgerDatabase,userId: string) {
  return db.transaction(async tx=>{
    await lockEligibleOwner(tx,userId);
    await tx.insert(schema.wallets).values({userId}).onConflictDoNothing();
    const wallet=await lockedWallet(tx,userId);
    const [grant]=await tx.select().from(schema.ledgerEvents).where(and(eq(schema.ledgerEvents.userId,userId),eq(schema.ledgerEvents.kind,'starting_grant')));
    if(grant)return {wallet:{availableCents:wallet.availableCents,reservedCents:wallet.reservedCents},eventId:grant.id,created:false};
    const [existing]=await tx.select({id:schema.ledgerEvents.id}).from(schema.ledgerEvents).where(eq(schema.ledgerEvents.userId,userId)).limit(1);
    if(existing||wallet.availableCents!==0n||wallet.reservedCents!==0n)throw new LedgerError('drift','An ungranted wallet must be empty.');
    const posted=await append(tx,userId,wallet,{kind:'starting_grant',idempotencyKey:`starting:${ECONOMY_VERSION}`,availableDelta:INITIAL_CREDITS_CENTS,reservedDelta:0n});
    return {...posted,created:true};
  });
}

// Internal transaction primitive for A04-A06. Never accept this structure from a
// public request or call it outside the order/reservation's owning transaction.
// Deferred constraints require held cash reservations to match the final wallet.
export async function postOrderMovement(tx: LedgerTransaction,userId: string,input: OrderMovement) {
  if(!input||!['buy_reserve','buy_cancel','buy_settle','sell_settle'].includes(input.kind)||
    typeof input.orderId!=='string'||!input.orderId||typeof input.idempotencyKey!=='string'||input.idempotencyKey.length<1||input.idempotencyKey.length>200)throw new LedgerError('invalid','Invalid ledger movement.');
  bounded(input.amountCents);
  const wallet=await lockBackingAccount(tx,userId);
  const [order]=await tx.select().from(schema.orders).where(and(eq(schema.orders.id,input.orderId),eq(schema.orders.userId,userId))).for('update');
  if(!order)throw new LedgerError('ineligible','Owned order required.');
  if((input.kind==='sell_settle')!==(order.side==='sell')||(order.side==='buy'&&input.amountCents!==order.amountCents))throw new LedgerError('invalid','Movement must match the order intent.');
  const amount=input.amountCents;
  const availableDelta=input.kind==='buy_reserve'?-amount:input.kind==='buy_settle'?0n:amount;
  const reservedDelta=input.kind==='buy_reserve'?amount:input.kind==='sell_settle'?0n:-amount;
  const [prior]=await tx.select().from(schema.ledgerEvents).where(and(eq(schema.ledgerEvents.userId,userId),eq(schema.ledgerEvents.idempotencyKey,input.idempotencyKey)));
  if(prior){
    if(prior.kind!==input.kind||prior.orderId!==input.orderId||prior.artistId!==order.artistId||prior.availableDelta!==availableDelta||prior.reservedDelta!==reservedDelta)throw new LedgerError('conflict','Ledger request key was already used for another intent.');
    return {wallet:{availableCents:wallet.availableCents,reservedCents:wallet.reservedCents},eventId:prior.id,applied:false};
  }
  const [sameKind]=await tx.select({id:schema.ledgerEvents.id}).from(schema.ledgerEvents).where(and(eq(schema.ledgerEvents.orderId,input.orderId),eq(schema.ledgerEvents.kind,input.kind)));
  if(sameKind)throw new LedgerError('conflict','Order movement already exists under another request key.');
  const posted=await append(tx,userId,wallet,{kind:input.kind,idempotencyKey:input.idempotencyKey,orderId:order.id,artistId:order.artistId,availableDelta,reservedDelta});
  return {...posted,applied:true};
}

export async function reconcileWallet(db: Pick<LedgerDatabase,'execute'>,userId: string) {
  // One SQL statement gives a coherent MVCC snapshot while trades are committing.
  const result=await db.execute(sql`SELECT u.id,w.user_id IS NOT NULL AS wallet_present,
    w.available_cents::text,w.reserved_cents::text,
    coalesce(l.available,0)::text AS ledger_available,coalesce(l.reserved,0)::text AS ledger_reserved,
    coalesce(l.events,0)::text AS event_count,coalesce(l.grants,0)::text AS grant_count,
    coalesce(r.held,0)::text AS held_reservations,
    coalesce(r.invalid_held,0)::text AS invalid_held
    FROM "user" u LEFT JOIN wallets w ON w.user_id=u.id
    LEFT JOIN LATERAL (SELECT sum(available_delta::numeric) AS available,sum(reserved_delta::numeric) AS reserved,
      count(*) AS events,count(*) FILTER(WHERE kind='starting_grant') AS grants FROM ledger_events WHERE user_id=u.id) l ON true
    LEFT JOIN LATERAL (SELECT sum(c.amount_cents::numeric) FILTER(WHERE c.status='held') AS held,
      count(*) FILTER(WHERE c.status='held' AND o.status<>'queued') AS invalid_held
      FROM cash_reservations c JOIN orders o ON o.id=c.order_id WHERE c.user_id=u.id) r ON true
    WHERE u.id=${userId}`);
  const row=result.rows[0];if(!row)return null;
  const violations:string[]=[];
  if(row.wallet_present){
    if(row.available_cents!==row.ledger_available)violations.push('available_ledger_mismatch');
    if(row.reserved_cents!==row.ledger_reserved)violations.push('reserved_ledger_mismatch');
    if(row.reserved_cents!==row.held_reservations)violations.push('reservation_mismatch');
    if(row.grant_count!=='1')violations.push('starting_grant_count');
  }else if(row.event_count!=='0'||row.held_reservations!=='0')violations.push('missing_wallet');
  if(row.invalid_held!=='0')violations.push('held_reservation_on_terminal_order');
  return {userId,state:row.wallet_present?'initialized':'uninitialized',ok:violations.length===0,violations,
    wallet:row.wallet_present?{availableCents:String(row.available_cents),reservedCents:String(row.reserved_cents)}:null,
    ledger:{availableCents:String(row.ledger_available),reservedCents:String(row.ledger_reserved),eventCount:String(row.event_count),startingGrantCount:String(row.grant_count)},
    heldReservationCents:String(row.held_reservations)};
}
export function walletWire(balance: Balance){return {availableCents:balance.availableCents.toString(),reservedCents:balance.reservedCents.toString()};}

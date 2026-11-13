'use client';
import {useCallback, useEffect, useRef, useState} from 'react';
import type {FormEvent} from 'react';
import {MAX_CENTS, MIN_BACKING_CENTS, parseCreditCents} from '../../domain/backing-policy';

type Wallet = {availableCents:string; reservedCents:string};
type Artist = {id:string; name:string; listenerCount:string; observedAt:string};
type Order = {
  id:string; artistId:string; artistName:string; side:'buy'; status:'queued'|'cancelled'|'settled';
  amountCents:string; acceptedAt:string; earliestCutoff:string; cancelledAt:string|null; settledAt:string|null;
  economyVersion:string; placement:{snapshotId:string;listenerCount:string;observedAt:string};
  pendingStatus:'awaiting_update'|'delayed'|null;
};
type Desk = {wallet:Wallet|null; artists:Artist[]; orders:Order[]; nextCursor:string|null; serverTime:string};
type Intent = {artistId:string; amountCents:string; idempotencyKey:string};
type OrderResult = {order:Order; wallet:Wallet; created?:boolean; cancelled?:boolean};
class RequestError extends Error {
  readonly code?:string;
  readonly intentAbsent:boolean;
  constructor(message:string, code?:string, intentAbsent=false) {super(message);this.code=code;this.intentAbsent=intentAbsent;}
}
function credits(value:string) {
  try {
    const amount=BigInt(value), whole=amount/100n, fraction=amount%100n;
    return whole.toLocaleString('en-US')+(fraction ? '.'+fraction.toString().padStart(2,'0') : '');
  } catch {return 'Unavailable';}
}
function integer(value:string) {try{return BigInt(value).toLocaleString('en-US');}catch{return 'Unavailable';}}
function utc(value:string) {
  const date=new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('en-GB',{timeZone:'UTC',year:'numeric',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})+' UTC' : 'Unavailable';
}
function isIntent(value:unknown): value is Intent {
  if(!value||typeof value!=='object')return false;
  const intent=value as Partial<Intent>;
  return typeof intent.artistId==='string'&&intent.artistId.length>0&&intent.artistId.length<=200&&
    typeof intent.amountCents==='string'&&/^[1-9]\d{0,18}$/.test(intent.amountCents)&&
    BigInt(intent.amountCents)>=MIN_BACKING_CENTS&&BigInt(intent.amountCents)<=MAX_CENTS&&
    typeof intent.idempotencyKey==='string'&&/^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$/.test(intent.idempotencyKey);
}
function mergeOrder(desk:Desk|null,result:OrderResult):Desk|null {
  if(!desk)return null;
  return {...desk,wallet:result.wallet,orders:[result.order,...desk.orders.filter(order=>order.id!==result.order.id)]};
}

export function BackingPanel({userId}:{userId:string}) {
  const [desk,setDesk]=useState<Desk|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState<string|null>(null);
  const [message,setMessage]=useState(''),[readError,setReadError]=useState('');
  const [artistId,setArtistId]=useState(''),[amount,setAmount]=useState('250'),[intent,setIntent]=useState<Intent|null>(null);
  const mounted=useRef(false),requests=useRef(new Set<AbortController>());
  const storageKey='first-press:pending-server-buy:'+userId;
  const request=useCallback(async<T,>(url:string,body?:unknown):Promise<T>=>{
    const controller=new AbortController();requests.current.add(controller);
    const timeout=window.setTimeout(()=>controller.abort(),20_000);
    try {
      const response=await fetch(url,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',signal:controller.signal,
        headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
      const value=await response.json();
      if(!response.ok)throw new RequestError(typeof value.error==='string'?value.error:'The backing service could not finish this request.',typeof value.code==='string'?value.code:undefined,value.intentAbsent===true);
      return value as T;
    } finally {window.clearTimeout(timeout);requests.current.delete(controller);}
  },[]);
  const refresh=useCallback(async()=>{
    const value=await request<Desk>('/api/account/backing');
    if(mounted.current){setDesk(value);setReadError('');}
  },[request]);
  useEffect(()=>{
    mounted.current=true;
    let active=true;
    try {
      const saved=sessionStorage.getItem(storageKey);
      if(saved&&saved.length<=1024) {
        const value:unknown=JSON.parse(saved);
        if(isIntent(value))setIntent(value);
        else sessionStorage.removeItem(storageKey);
      }
    } catch {/* A denied storage API never becomes wallet or order authority. */}
    void refresh().catch(()=>{if(active&&mounted.current)setReadError('We could not load your server wallet and orders. Try refreshing.');}).finally(()=>{if(active&&mounted.current)setLoading(false);});
    const controllers=requests.current;
    return ()=>{active=false;mounted.current=false;for(const controller of controllers)controller.abort();};
  },[refresh,storageKey]);
  function remember(value:Intent|null) {
    setIntent(value);
    try {if(value)sessionStorage.setItem(storageKey,JSON.stringify(value));else sessionStorage.removeItem(storageKey);}
    catch {/* The mounted page still retains its retry key when storage is unavailable. */}
  }
  async function updateReadView() {
    try {await refresh();}
    catch {if(mounted.current)setReadError('Your last action is confirmed, but we could not refresh the full list. Refresh to see the latest state.');}
  }
  async function initialize() {
    setBusy('wallet');setMessage('');
    try {
      const result=await request<{wallet:Wallet}>('/api/account/wallet',{});
      if(!mounted.current)return;
      setDesk(current=>current?{...current,wallet:result.wallet}:current);
      setMessage('Your server wallet is ready.');await updateReadView();
    } catch(error){if(mounted.current)setMessage(error instanceof RequestError?error.message:'We could not confirm wallet initialization. You can safely try again.');}
    finally {if(mounted.current)setBusy(null);}
  }
  async function buy(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();if(busy||!desk)return;
    const previousIntent=intent;
    let attempt=previousIntent;
    if(!attempt) {
      try {
        const cents=parseCreditCents(amount);
        if(cents<MIN_BACKING_CENTS)throw Error();
        const selected=desk.artists.find(artist=>artist.id===(artistId||desk.artists[0]?.id));
        if(!selected)throw Error();
        attempt={artistId:selected.id,amountCents:cents.toString(),idempotencyKey:crypto.randomUUID()};
      } catch {setMessage('Choose an available artist and enter at least 1 Credit, with no more than two decimal places.');return;}
    }
    remember(attempt);setBusy('buy');setMessage('');
    try {
      const result=await request<OrderResult>('/api/account/orders',attempt);
      if(!mounted.current)return;
      setDesk(current=>mergeOrder(current,result));remember(null);
      setMessage(result.order.status==='queued'?'Backing queued. Your Credits are reserved until it settles or you cancel.':`Your earlier order is ${result.order.status}. No duplicate was created.`);
      await updateReadView();
    } catch(error) {
      if(!mounted.current)return;
      const definitive=error instanceof RequestError&&['invalid','not_found','ineligible','uninitialized','insufficient','conflict'].includes(error.code??'');
      if(definitive&&(!previousIntent||error.intentAbsent)){remember(null);setMessage(error.message);}
      else setMessage((error instanceof RequestError?error.message:'We could not confirm whether your order was accepted.')+' Retry this same order to check its result before starting another.');
    } finally {if(mounted.current)setBusy(null);}
  }
  async function cancel(order:Order) {
    setBusy(order.id);setMessage('');
    try {
      const result=await request<OrderResult>('/api/account/orders/'+encodeURIComponent(order.id)+'/cancel',{});
      if(!mounted.current)return;
      setDesk(current=>mergeOrder(current,result));setMessage('Backing cancelled. Its reserved Credits are available again.');
      await updateReadView();
    } catch(error) {
      if(!mounted.current)return;
      setMessage(error instanceof RequestError?error.message:'We could not confirm cancellation. Refresh or retry; it will only release Credits once.');
      try {await refresh();}catch {if(mounted.current)setReadError('We could not refresh this order. Its last known state is shown.');}
    } finally {if(mounted.current)setBusy(null);}
  }
  async function loadMore() {
    if(!desk?.nextCursor)return;
    setBusy('more');setReadError('');
    try {
      const value=await request<Desk>('/api/account/backing?cursor='+encodeURIComponent(desk.nextCursor));
      if(mounted.current)setDesk(current=>current?{...value,orders:[...current.orders,...value.orders.filter(order=>!current.orders.some(existing=>existing.id===order.id))]}:value);
    } catch {if(mounted.current)setReadError('We could not load older orders. Your current list is still available.');}
    finally {if(mounted.current)setBusy(null);}
  }
  async function reload() {
    setBusy('refresh');
    try {await refresh();}catch {if(mounted.current)setReadError('We could not load the latest server state. Try again shortly.');}
    finally {if(mounted.current)setBusy(null);}
  }
  const selectedId=intent?.artistId||(desk?.artists.some(artist=>artist.id===artistId)?artistId:desk?.artists[0]?.id)||'';
  const selected=desk?.artists.find(artist=>artist.id===selectedId);
  const amountValue=intent ? (BigInt(intent.amountCents)/100n).toString()+'.'+(BigInt(intent.amountCents)%100n).toString().padStart(2,'0') : amount;
  return <section className="auth-paper backing-paper" aria-labelledby="server-backing-title">
    <div className="backing-heading"><span className="auth-kicker">CONNECTED BACKING</span><span className="backing-marker">ON THE SERVER</span></div>
    <h2 id="server-backing-title">Put your ears<br/>on record.</h2>
    <p>Reserve virtual Credits for an artist. Orders wait for a valid listener update; the final entry count is set when they settle. Pending orders earn no receipt.</p>
    <p className="backing-boundary">This beta currently supports queuing and cancellation. Settlement and receipts are not enabled yet.</p>
    <p className="backing-boundary">This wallet and these orders belong to your account. Your device’s demo collection stays separate.</p>
    {loading?<p role="status">Loading your server wallet and orders…</p>:<>
      {readError?<p className="auth-alert" role="alert">{readError}</p>:null}
      {!desk?<button className="auth-button" disabled={!!busy} onClick={reload}>Try loading backing again ↗</button>:<>
        <div className="backing-wallet" aria-label="Server Credit balances">
          <div><span>AVAILABLE CREDITS</span><strong>{desk.wallet?credits(desk.wallet.availableCents):'—'}<small>CR</small></strong></div>
          <div><span>RESERVED CREDITS</span><strong>{desk.wallet?credits(desk.wallet.reservedCents):'—'}<small>CR</small></strong></div>
        </div>
        <p className="auth-small backing-fine-print">Credits have no cash value. No purchase, transfer or cash redemption.</p>
        {!desk.wallet?<div className="backing-empty"><h3>Your first 1,000 Credits.</h3><p>Initialize your server wallet once to start. Returning here won’t reset your balance.</p><button className="auth-button" disabled={!!busy} onClick={initialize}>{busy==='wallet'?'Preparing your wallet…':'Initialize my server wallet ↗'}</button></div>:null}
        {desk.wallet&&(desk.artists.length>0||intent)?<form className="backing-form" onSubmit={buy} aria-label="Queue server backing">
          {intent?<p className="backing-retry" role="status">An order still needs confirmation. Retry it with the same details; this cannot create a duplicate.</p>:null}
          <label htmlFor="backing-artist">Artist<select id="backing-artist" value={selectedId} disabled={!!busy||!!intent} onChange={event=>setArtistId(event.target.value)} required>
            {intent&&!selected?<option value={intent.artistId}>Previous selection — awaiting confirmation</option>:null}
            {desk.artists.map(artist=><option key={artist.id} value={artist.id}>{artist.name}</option>)}
          </select></label>
          {selected?<p className="backing-estimate">Last known: <strong>{integer(selected.listenerCount)} monthly listeners</strong><small>Observed <time dateTime={selected.observedAt}>{utc(selected.observedAt)}</time>. This is an estimate, not your execution count.</small></p>:null}
          <label htmlFor="backing-amount">Credits to reserve<input id="backing-amount" value={amountValue} disabled={!!busy||!!intent} onChange={event=>setAmount(event.target.value)} inputMode="decimal" autoComplete="off" required maxLength={20} aria-describedby="backing-amount-help"/></label>
          <small id="backing-amount-help">Minimum 1 Credit. Your available balance is checked when you queue.</small>
          <button className="auth-button" disabled={!!busy} type="submit">{busy==='buy'?'Checking your order…':intent?'Retry this same backing ↗':'Queue server backing ↗'}</button>
        </form>:desk.wallet?<div className="backing-empty"><h3>No artists are open yet.</h3><p>Connected backing opens after an artist’s identity and fresh listener data are reviewed. You can still explore the demo.</p></div>:null}
        <div className="backing-orders-heading"><h3>Your backing orders</h3><button className="auth-secondary" disabled={!!busy} onClick={reload}>{busy==='refresh'?'Refreshing…':'Refresh orders ↻'}</button></div>
        {desk.orders.length?<ol className="backing-orders">{desk.orders.map(order=><li className="backing-order" key={order.id}>
          <div className="backing-order-top"><h4>{order.artistName}</h4><span className={'backing-order-status backing-status-'+order.status}>{order.status==='queued'?(order.pendingStatus==='delayed'?'DELAYED':'QUEUED'):order.status.toUpperCase()}</span></div>
          <strong className="backing-order-amount">{credits(order.amountCents)} <small>CR</small></strong>
          <dl><div><dt>Accepted by server</dt><dd><time dateTime={order.acceptedAt}>{utc(order.acceptedAt)}</time></dd></div><div><dt>Placement estimate</dt><dd>{integer(order.placement.listenerCount)} monthly listeners<small>Observed <time dateTime={order.placement.observedAt}>{utc(order.placement.observedAt)}</time></small></dd></div><div><dt>First eligible update</dt><dd><time dateTime={order.earliestCutoff}>{utc(order.earliestCutoff)}</time></dd></div></dl>
          {order.status==='queued'?<><p className="backing-order-note">{order.pendingStatus==='delayed'?'Delayed: waiting for a valid update. Your Credits stay reserved and you can cancel anytime.':'Waiting for a valid update. The entry count is not fixed yet. You can cancel until settlement.'}</p><button className="auth-secondary" disabled={!!busy} onClick={()=>cancel(order)}>{busy===order.id?'Checking cancellation…':'Cancel backing for '+order.artistName}</button></>:<p className="backing-order-note">{order.status==='cancelled'?'Cancelled. Reserved Credits released; no receipt earned.':'Settled. Cancellation is closed.'}{(order.cancelledAt||order.settledAt)?<small><time dateTime={(order.cancelledAt||order.settledAt)!}>{utc((order.cancelledAt||order.settledAt)!)}</time></small>:null}</p>}
        </li>)}</ol>:<p className="backing-empty-note">Your server order history starts here. Nothing queued yet.</p>}
        {desk.nextCursor?<button className="auth-secondary" disabled={!!busy} onClick={loadMore}>{busy==='more'?'Loading…':'Load older orders ↗'}</button>:null}
      </>}
    </>}
    <p className="auth-message backing-action-message" role="status" aria-live="polite">{message}</p>
  </section>;
}

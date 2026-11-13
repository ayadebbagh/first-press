'use client';
import {useCallback, useEffect, useRef, useState} from 'react';
import type {FormEvent} from 'react';
import {MAX_CENTS, MIN_BACKING_CENTS, parseCreditCents} from '../../domain/backing-policy';

type Wallet = {availableCents:string; reservedCents:string};
type Artist = {id:string; name:string; listenerCount:string; observedAt:string};
type Position = {
  artistId:string; artistName:string; lotCount:number; availableLotCount:number; reservedLotCount:number;
  estimatedValueCents:string|null; estimatedAvailableCents:string|null; listenerCount:string|null;
  observedAt:string|null; stale:boolean; canExit:boolean;
};
type Order = {
  id:string; artistId:string; artistName:string; side:'buy'|'sell'; status:'queued'|'cancelled'|'settled';
  amountCents:string|null; exitBasisPoints:number|null; estimatedProceedsCents:string|null;
  allocations:{lotId:string;quanta:string;status:'held'|'released'|'consumed'}[];
  acceptedAt:string; earliestCutoff:string; cancelledAt:string|null; settledAt:string|null;
  economyVersion:string; placement:{snapshotId:string;listenerCount:string;observedAt:string};
  pendingStatus:'awaiting_update'|'delayed'|null;
};
type Desk = {wallet:Wallet|null; artists:Artist[]; positions:Position[]; orders:Order[]; nextCursor:string|null; serverTime:string};
type Intent = {artistId:string; amountCents:string; idempotencyKey:string};
type ExitIntent = {artistId:string; exitBasisPoints:number; idempotencyKey:string};
type OrderResult = {order:Order; wallet:Wallet; positions?:Position[]; created?:boolean; cancelled?:boolean};
class RequestError extends Error {
  readonly code?:string;
  readonly intentAbsent:boolean;
  constructor(message:string, code?:string, intentAbsent=false) {super(message);this.code=code;this.intentAbsent=intentAbsent;}
}
function credits(value:string|null) {
  if(value===null)return 'Unavailable';
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
function isExitIntent(value:unknown): value is ExitIntent {
  if(!value||typeof value!=='object')return false;
  const intent=value as Partial<ExitIntent>;
  return typeof intent.artistId==='string'&&intent.artistId.length>0&&intent.artistId.length<=200&&
    typeof intent.exitBasisPoints==='number'&&Number.isInteger(intent.exitBasisPoints)&&intent.exitBasisPoints>=1&&intent.exitBasisPoints<=10_000&&
    typeof intent.idempotencyKey==='string'&&/^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$/.test(intent.idempotencyKey);
}
function percentage(basisPoints:number) {return Math.floor(basisPoints/100)+'.'+(basisPoints%100).toString().padStart(2,'0');}
function exitPausedReason(position:Position) {
  if(position.availableLotCount===0)return 'All backing is reserved for pending exits. Cancel a pending exit to release its backing.';
  if(position.stale)return 'Listener data is stale. New exits are paused until a fresh, reviewed update is available.';
  return 'New exits are paused. A fresh, reviewed listener count and an eligible artist are required.';
}
function mergeOrder(desk:Desk|null,result:OrderResult):Desk|null {
  if(!desk)return null;
  return {...desk,wallet:result.wallet,positions:result.positions??desk.positions,orders:[result.order,...desk.orders.filter(order=>order.id!==result.order.id)]};
}

export function BackingPanel({userId}:{userId:string}) {
  const [desk,setDesk]=useState<Desk|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState<string|null>(null);
  const [message,setMessage]=useState(''),[readError,setReadError]=useState('');
  const [artistId,setArtistId]=useState(''),[amount,setAmount]=useState('250'),[intent,setIntent]=useState<Intent|null>(null);
  const [exitArtistId,setExitArtistId]=useState(''),[exitPercent,setExitPercent]=useState('100.00'),[exitIntent,setExitIntent]=useState<ExitIntent|null>(null);
  const mounted=useRef(false),requests=useRef(new Set<AbortController>());
  const storageKey='first-press:pending-server-buy:'+userId;
  const exitStorageKey='first-press:pending-server-exit:'+userId;
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
    try {
      const saved=sessionStorage.getItem(exitStorageKey);
      if(saved&&saved.length<=1024) {
        const value:unknown=JSON.parse(saved);
        if(isExitIntent(value))setExitIntent({artistId:value.artistId,exitBasisPoints:value.exitBasisPoints,idempotencyKey:value.idempotencyKey});
        else sessionStorage.removeItem(exitStorageKey);
      }
    } catch {/* Stored intents are retry hints; the server authorizes every allocation. */}
    void refresh().catch(()=>{if(active&&mounted.current)setReadError('We could not load your server wallet and orders. Try refreshing.');}).finally(()=>{if(active&&mounted.current)setLoading(false);});
    const controllers=requests.current;
    return ()=>{active=false;mounted.current=false;for(const controller of controllers)controller.abort();};
  },[refresh,storageKey,exitStorageKey]);
  function remember(value:Intent|null) {
    setIntent(value);
    try {if(value)sessionStorage.setItem(storageKey,JSON.stringify(value));else sessionStorage.removeItem(storageKey);}
    catch {/* The mounted page still retains its retry key when storage is unavailable. */}
  }
  function rememberExit(value:ExitIntent|null) {
    setExitIntent(value);
    try {if(value)sessionStorage.setItem(exitStorageKey,JSON.stringify(value));else sessionStorage.removeItem(exitStorageKey);}
    catch {/* Keep the exact retry intent in memory if session storage is denied. */}
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
    if(busy)return;
    setBusy(order.id);setMessage('');
    try {
      const result=await request<OrderResult>('/api/account/orders/'+encodeURIComponent(order.id)+'/cancel',{});
      if(!mounted.current)return;
      setDesk(current=>mergeOrder(current,result));
      setMessage(result.order.status==='settled'?'This order already settled. Cancellation is closed.':order.side==='sell'?'Exit cancelled. Its reserved backing is available again. Your Credit balance has not changed; original support history is retained.':'Backing cancelled. Its reserved Credits are available again.');
      await updateReadView();
    } catch(error) {
      if(!mounted.current)return;
      setMessage(error instanceof RequestError?error.message:order.side==='sell'?'We could not confirm cancellation. Refresh or retry; reserved backing can only be released once.':'We could not confirm cancellation. Refresh or retry; it will only release Credits once.');
      try {await refresh();}catch {if(mounted.current)setReadError('We could not refresh this order. Its last known state is shown.');}
    } finally {if(mounted.current)setBusy(null);}
  }
  async function exit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();if(busy||!desk)return;
    const previousIntent=exitIntent;
    let attempt=previousIntent;
    if(!attempt) {
      try {
        // Parse decimal percent as exact hundredths before converting bounded BP to Number.
        const basisPoints=parseCreditCents(exitPercent);
        if(basisPoints<1n||basisPoints>10_000n)throw Error();
        const selected=desk.positions.find(position=>position.artistId===selectedExitId);
        if(!selected?.canExit||selected.stale||selected.availableLotCount===0)throw Error();
        attempt={artistId:selected.artistId,exitBasisPoints:Number(basisPoints),idempotencyKey:crypto.randomUUID()};
      } catch {setMessage('Choose available backing and enter 0.01% to 100.00%, with no more than two decimal places.');return;}
    }
    rememberExit(attempt);setBusy('exit');setMessage('');
    try {
      const result=await request<OrderResult>('/api/account/orders/exit',attempt);
      if(!mounted.current)return;
      setDesk(current=>mergeOrder(current,result));rememberExit(null);
      setMessage(result.order.status==='queued'?'Exit queued. Backing quantities are reserved; no Credits have been credited. Final payout depends on the execution listener count.':`Your earlier exit is ${result.order.status}. No duplicate was created.`);
      await updateReadView();
    } catch(error) {
      if(!mounted.current)return;
      const definitive=error instanceof RequestError&&['invalid','not_found','ineligible','uninitialized','insufficient','conflict'].includes(error.code??'');
      if(definitive&&(!previousIntent||error.intentAbsent)){rememberExit(null);setMessage(error.message);}
      else setMessage((error instanceof RequestError?error.message:'We could not confirm whether your exit was accepted.')+' Retry this same exit to check its result before starting another exit.');
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
  const positions=desk?.positions??[];
  const selectedExitId=exitIntent?.artistId||(positions.some(position=>position.artistId===exitArtistId)?exitArtistId:positions.find(position=>position.canExit&&!position.stale&&position.availableLotCount>0)?.artistId)||positions[0]?.artistId||'';
  const selectedExit=positions.find(position=>position.artistId===selectedExitId);
  const canQueueExit=!!exitIntent||!!(selectedExit?.canExit&&!selectedExit.stale&&selectedExit.availableLotCount>0);
  return <section className="auth-paper backing-paper" aria-labelledby="server-backing-title">
    <div className="backing-heading"><span className="auth-kicker">CONNECTED BACKING</span><span className="backing-marker">ON THE SERVER</span></div>
    <h2 id="server-backing-title">Put your ears<br/>on record.</h2>
    <p>Reserve virtual Credits for an artist. Orders wait for a valid listener update; the final entry count is set when they settle. Pending orders earn no receipt.</p>
    <p className="backing-boundary">This beta currently supports queuing backing and exits, plus cancellation. Execution (settlement) and receipts are not enabled yet.</p>
    <p className="backing-boundary">This wallet and these orders belong to your account. Your device’s demo collection stays separate.</p>
    {loading?<p role="status">Loading your server wallet, backing and orders…</p>:<>
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
        <section className="backing-positions" aria-labelledby="backing-positions-title">
          <h3 id="backing-positions-title">Your current backing</h3>
          <p className="backing-position-intro">Settled backing stays here while exits wait. Original support history is retained after an exit.</p>
          {positions.length?<ul className="backing-position-list">{positions.map(position=><li className="backing-position" key={position.artistId}>
            <div className="backing-position-top"><strong>{position.artistName}</strong><span className="backing-position-marker">{position.stale?'STALE ESTIMATE':position.canExit?'BACKING HELD':'EXITS PAUSED'}</span></div>
            <dl className="backing-position-values">
              <div><dt>Estimated backing value</dt><dd>{position.estimatedValueCents===null?'Unavailable':credits(position.estimatedValueCents)+' CR'}</dd></div>
              <div><dt>Estimated available value</dt><dd>{position.estimatedAvailableCents===null?'Unavailable':credits(position.estimatedAvailableCents)+' CR'}</dd></div>
              <div><dt>Backing lots held</dt><dd>{position.lotCount}</dd></div>
              <div><dt>Lots with available backing</dt><dd>{position.availableLotCount}</dd></div>
              <div><dt>Lots with reserved backing</dt><dd>{position.reservedLotCount}</dd></div>
            </dl>
            <p className="backing-position-source">{position.listenerCount===null?'Spotify monthly listeners unavailable.':<>{integer(position.listenerCount)} Spotify monthly listeners.</>}{' '}
              {position.observedAt?<span>Observed <time dateTime={position.observedAt}>{utc(position.observedAt)}</time>.</span>:<span>Observation time unavailable.</span>}
              {position.stale?<strong> Stale data — this is the last known estimate.</strong>:null}
            </p>
            <p className="backing-position-note">Estimates are not an executable quote or spendable Credits. Available and reserved portions may belong to the same lot.</p>
            {!position.canExit||position.stale||position.availableLotCount===0?<p className="backing-position-paused">{exitPausedReason(position)} Existing queued exits remain cancellable.</p>:null}
          </li>)}</ul>:<div className="backing-empty"><p>No settled backing yet. Queued buys do not create owned lots until execution.</p></div>}
          {positions.length>0||exitIntent?<form className="backing-form backing-exit-form" onSubmit={exit} aria-label="Queue server exit">
            <h3>Queue an exit</h3>
            {exitIntent?<p className="backing-retry" role="status">An exit still needs confirmation. Retry it with the same details and key; this cannot create a duplicate, even if new exits are now paused.</p>:null}
            <label htmlFor="backing-exit-artist">Backing to exit<select id="backing-exit-artist" value={selectedExitId} disabled={!!busy||!!exitIntent} onChange={event=>setExitArtistId(event.target.value)} required>
              {exitIntent&&!selectedExit?<option value={exitIntent.artistId}>Previous backing — awaiting confirmation</option>:null}
              {positions.map(position=><option key={position.artistId} value={position.artistId}>{position.artistName}</option>)}
            </select></label>
            <label htmlFor="backing-exit-percent">Percentage of available backing<input id="backing-exit-percent" value={exitIntent?percentage(exitIntent.exitBasisPoints):exitPercent} disabled={!!busy||!!exitIntent||!canQueueExit} onChange={event=>setExitPercent(event.target.value)} inputMode="decimal" autoComplete="off" required maxLength={20} aria-describedby="backing-exit-help backing-exit-availability"/></label>
            <p id="backing-exit-help" className="backing-exit-help">0.01%–100.00%, with up to two decimal places. The same percentage of each available lot is reserved, rounded down to the supported fraction precision. 100% reserves all currently available backing. Later buys do not enlarge this exit.</p>
            <p id="backing-exit-availability" className="backing-exit-help">{!canQueueExit&&selectedExit?exitPausedReason(selectedExit):'Queuing reserves backing quantities only. No Credits are credited until execution; final payout depends on the execution listener count.'}</p>
            <button className="auth-button" disabled={!!busy||!canQueueExit} type="submit">{busy==='exit'?'Checking your exit…':exitIntent?'Retry this same exit ↗':'Queue server exit ↗'}</button>
          </form>:null}
        </section>
        <div className="backing-orders-heading"><h3>Your backing orders</h3><button className="auth-secondary" disabled={!!busy} onClick={reload}>{busy==='refresh'?'Refreshing…':'Refresh orders ↻'}</button></div>
        {desk.orders.length?<ol className="backing-orders">{desk.orders.map(order=><li className="backing-order" key={order.id}>
          <div className="backing-order-top"><h4>{order.artistName}</h4><span className={'backing-order-status backing-status-'+order.status}>{order.status==='queued'?(order.pendingStatus==='delayed'?'DELAYED':'QUEUED'):order.status.toUpperCase()}</span></div>
          {order.side==='sell'?<><strong className="backing-order-amount">{order.exitBasisPoints===null?'Unavailable':percentage(order.exitBasisPoints)+'%'} <small>OF AVAILABLE BACKING AT PLACEMENT</small></strong>
            <dl className="backing-exit-details"><div><dt>Allocated lots</dt><dd>{order.allocations.length}</dd></div><div><dt>Estimated proceeds at placement</dt><dd>{order.estimatedProceedsCents===null?'Unavailable':credits(order.estimatedProceedsCents)+' CR'}<small>Estimate only. Final payout depends on the execution listener count. This is not credited funds.</small></dd></div></dl></>:<strong className="backing-order-amount">{credits(order.amountCents)} <small>CR</small></strong>}
          <dl><div><dt>Accepted by server</dt><dd><time dateTime={order.acceptedAt}>{utc(order.acceptedAt)}</time></dd></div><div><dt>Placement estimate</dt><dd>{integer(order.placement.listenerCount)} monthly listeners<small>Observed <time dateTime={order.placement.observedAt}>{utc(order.placement.observedAt)}</time></small></dd></div><div><dt>First eligible update</dt><dd><time dateTime={order.earliestCutoff}>{utc(order.earliestCutoff)}</time></dd></div></dl>
          {order.status==='queued'?<><p className="backing-order-note">{order.side==='sell'?(order.pendingStatus==='delayed'?'Delayed: waiting for a valid update. Your backing quantities stay reserved; no Credits have been credited. You can cancel until execution.':'Waiting for a valid update. Backing quantities are reserved; no Credits have been credited. You can cancel until execution.'):order.pendingStatus==='delayed'?'Delayed: waiting for a valid update. Your Credits stay reserved and you can cancel anytime.':'Waiting for a valid update. The entry count is not fixed yet. You can cancel until settlement.'}</p><button className="auth-secondary" disabled={!!busy} onClick={()=>cancel(order)}>{busy===order.id?'Checking cancellation…':(order.side==='sell'?'Cancel exit for ':'Cancel backing for ')+order.artistName}</button></>:<p className="backing-order-note">{order.status==='cancelled'?(order.side==='sell'?'Cancelled. Reserved backing released; no Credits credited or refunded. Original support history retained.':'Cancelled. Reserved Credits released; no receipt earned.'):(order.side==='sell'?'Exit settled. Original support history retained. Cancellation is closed.':'Settled. Cancellation is closed.')}{(order.cancelledAt||order.settledAt)?<small><time dateTime={(order.cancelledAt||order.settledAt)!}>{utc((order.cancelledAt||order.settledAt)!)}</time></small>:null}</p>}
        </li>)}</ol>:<p className="backing-empty-note">Your server order history starts here. Nothing queued yet.</p>}
        {desk.nextCursor?<button className="auth-secondary" disabled={!!busy} onClick={loadMore}>{busy==='more'?'Loading…':'Load older orders ↗'}</button>:null}
      </>}
    </>}
    <p className="auth-message backing-action-message" role="status" aria-live="polite">{message}</p>
  </section>;
}

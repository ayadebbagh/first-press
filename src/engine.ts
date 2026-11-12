import type {Artist,BetaState,Side} from './types.ts';
import { artists } from './catalog.ts';

export const STORAGE_KEY = 'firstpress.beta.v1';
export const initialState = (): BetaState => ({version:1, credits:1000, snapshot:0, holdings:{}, orders:[], receipts:[], watching:[], requests:[], daily:{day:'', votes:[], guess:[], revealed:false}, weeklyClaimed:null});
export const money = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export function listenersAt(artist: Artist, snapshot: number) {
  let value=artist.listeners;
  for(let i=1;i<=snapshot;i++) value=Math.round(value*(1+(artist.change*(i%3===0 ? -.55 : .35))/100));
  return value;
}
export const priceAt = (artist: Artist, snapshot: number) => listenersAt(artist,snapshot)/artist.listeners*100;
export function portfolioValue(state: BetaState) {
  return Object.entries(state.holdings).reduce((sum,[id,h])=>sum+h.units*priceAt(artists.find(a=>a.id===id)!,state.snapshot),0);
}
export const reservedCredits = (state: BetaState) => state.orders.filter(o=>o.side==='buy').reduce((sum,o)=>sum+o.amount,0);
export const reservedUnits = (state: BetaState,id: string) => state.orders.reduce((sum,o)=>sum+(o.side==='sell'&&o.artistId===id?o.units:0),0);
export function queueOrder(state: BetaState, {artistId, side, amount}: {artistId: string; side: Side; amount: number}, id: string, now: string) {
  if(!artists.some(a=>a.id===artistId)) throw new Error('Choose an artist from the catalog.');
  if(!['buy','sell'].includes(side)) throw new Error('Choose a valid order.');
  if(!Number.isFinite(amount)||amount<=0) throw new Error('Enter an amount greater than zero.');
  const next=structuredClone(state);
  if(side==='buy') {
    if(amount!==money(amount)) throw new Error('Use at most two decimal places.');
    if(amount>next.credits) throw new Error('You do not have enough available Credits.');
    next.credits=money(next.credits-amount);
    next.orders.push({id,artistId,side,amount,queuedAt:now,snapshot:state.snapshot});
  } else {
    const available=(next.holdings[artistId]?.units||0)-reservedUnits(next,artistId);
    if(amount>available+1e-8) throw new Error('That amount is already queued or exceeds your holding.');
    next.orders.push({id,artistId,side,units:Math.min(amount,available),queuedAt:now,snapshot:state.snapshot});
  }
  return next;
}
export function cancelOrder(state: BetaState, id: string) {
  const next=structuredClone(state), order=next.orders.find(o=>o.id===id);
  if(!order) return next;
  if(order.side==='buy') next.credits=money(next.credits+order.amount);
  next.orders=next.orders.filter(o=>o.id!==id);
  return next;
}
export function advanceSnapshot(state: BetaState, now: string) {
  const next=structuredClone(state); next.snapshot++;
  for(const order of next.orders) {
    const artist=artists.find(a=>a.id===order.artistId)!, price=priceAt(artist,next.snapshot);
    const h=next.holdings[artist.id]||{units:0,cost:0};
    if(order.side==='buy') {
      const units=order.amount/price;
      next.holdings[artist.id]={units:h.units+units,cost:money(h.cost+order.amount)};
      next.receipts.unshift({id:order.id,artistId:artist.id,credits:order.amount,units,entryPrice:price,listeners:listenersAt(artist,next.snapshot),snapshot:next.snapshot,createdAt:now});
    } else {
      next.credits=money(next.credits+order.units*price);
      const remaining=Math.max(0,h.units-order.units);
      if(remaining<1e-8) delete next.holdings[artist.id];
      else next.holdings[artist.id]={units:remaining,cost:money(h.cost*remaining/h.units)};
    }
  }
  next.orders=[];
  return next;
}
export function loadState(raw: string | null): BetaState {
  try {
    const s=JSON.parse(raw || 'null');
    if(s?.version===1&&Number.isFinite(s.credits)&&s.credits>=0&&Number.isInteger(s.snapshot)&&s.snapshot>=0&&s.snapshot<=10000&&s.holdings&&Array.isArray(s.orders)&&Array.isArray(s.receipts)&&Array.isArray(s.watching)&&Array.isArray(s.requests)&&s.daily) return s;
  } catch {}
  return initialState();
}

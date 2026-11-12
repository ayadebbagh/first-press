import type {Artist} from '../types.ts';
import {listenersAt} from '../engine.ts';

export const HISTORY_DAY_MS=24*60*60*1000;
const DEMO_EPOCH=Date.UTC(2026,10,8);
export interface ListenerPoint {at: number;value: number}
export interface ListenerHistory {
  kind: 'demo'|'verified';
  metric: 'monthly_listeners';
  points: ListenerPoint[];
  asOf: number;
  expectedIntervalMs: number;
}

export function demoListenerHistory(artist: Artist,snapshot: number): ListenerHistory {
  const asOf=DEMO_EPOCH+snapshot*HISTORY_DAY_MS/2;
  const points: ListenerPoint[]=[];
  const seed=Number(artist.id.slice(-3));
  // Explicitly generated illustration, not downloaded/backfilled Spotify data.
  for(let ago=90;ago>=0;ago--){
    const trend=artist.listeners/Math.pow(1+artist.change/100,ago/7);
    const texture=1+.014*Math.sin(ago*(.47+seed/100))*Math.sin(Math.PI*ago/7);
    points.push({at:DEMO_EPOCH-ago*HISTORY_DAY_MS,value:Math.round(trend*texture)});
  }
  // Manual demo updates append to the illustration; they do not rewrite it.
  for(let index=Math.max(1,snapshot-180);index<=snapshot;index++)points.push({at:DEMO_EPOCH+index*HISTORY_DAY_MS/2,value:listenersAt(artist,index)});
  return {kind:'demo',metric:'monthly_listeners',points,asOf,expectedIntervalMs:HISTORY_DAY_MS};
}
export function historyWindow(history: ListenerHistory,days: number){
  if(!Number.isFinite(history.asOf)||days<=0||!Number.isFinite(days))throw new RangeError('Invalid history window');
  const start=history.asOf-days*HISTORY_DAY_MS;
  const times=new Map<number,ListenerPoint|null>();
  for(const point of history.points){
    if(!Number.isSafeInteger(point.at)||point.at<start||point.at>history.asOf||!Number.isSafeInteger(point.value)||point.value<0||point.value>1e12)continue;
    const previous=times.get(point.at);
    // Conflicting readings need the source pipeline to resolve them, not a
    // chart that picks a more flattering value at the same timestamp.
    if(previous===null||previous&&previous.value!==point.value)times.set(point.at,null);
    else times.set(point.at,point);
  }
  const points=[...times.values()].filter((p):p is ListenerPoint=>p!==null).sort((a,b)=>a.at-b.at);
  const gap=history.expectedIntervalMs>0?history.expectedIntervalMs*1.5:HISTORY_DAY_MS;
  const segments: ListenerPoint[][]=[];
  for(const point of points){
    const last=segments.at(-1),previous=last?.at(-1);
    if(!last||previous&&point.at-previous.at>gap)segments.push([point]);
    else last.push(point);
  }
  const low=points.length?Math.min(...points.map(p=>p.value)):0;
  const high=points.length?Math.max(...points.map(p=>p.value)):1;
  const pad=Math.max(1,(high-low)*.15,high*.01);
  const min=Math.max(0,Math.floor(low-pad)),max=Math.ceil(high+pad);
  const first=points[0]?.value,last=points.at(-1)?.value;
  const change=points.length>=2&&first!==undefined&&first>0?((last!-first)/first)*100:null;
  return {points,segments,start,end:history.asOf,min,max,change};
}

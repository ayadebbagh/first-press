'use client';
import {useId,useMemo,useState} from 'react';
import type {KeyboardEvent,PointerEvent} from 'react';
import type {ListenerHistory,ListenerPoint} from '../lib/listener-history.ts';
import {HISTORY_DAY_MS,historyWindow} from '../lib/listener-history.ts';
import {compact,fmt} from '../lib/format.ts';

const date=(at: number)=>new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',timeZone:'UTC'}).format(at);
export function ListenerHistoryChart({history}: {history: ListenerHistory}){
  const [days,setDays]=useState(7),[selectedAt,setSelectedAt]=useState<number>();
  const helpId=useId();
  const view=useMemo(()=>historyWindow(history,days),[history,days]);
  const found=view.points.findIndex(p=>p.at===selectedAt);
  const index=found>=0?found:view.points.length-1;
  const selected=view.points[index];
  const x=(p: ListenerPoint)=>8+(p.at-view.start)/(view.end-view.start)*484;
  const y=(p: ListenerPoint)=>164-(p.value-view.min)/(view.max-view.min)*148;
  const describe=(p: ListenerPoint)=>history.kind==='demo'?(p.at===history.asOf?'Latest sample':`${fmt((history.asOf-p.at)/HISTORY_DAY_MS)}d earlier · sample`):`${date(p.at)} · ${new Date(p.at).toISOString().slice(11,16)} UTC`;
  function inspect(event: PointerEvent<HTMLDivElement>){
    if(!view.points.length)return;
    const bounds=event.currentTarget.getBoundingClientRect();
    const fraction=Math.min(1,Math.max(0,((event.clientX-bounds.left)/bounds.width*500-8)/484));
    const target=view.start+fraction*(view.end-view.start);
    const nearest=view.points.reduce((a,b)=>Math.abs(b.at-target)<Math.abs(a.at-target)?b:a);
    setSelectedAt(nearest.at);
  }
  function key(event: KeyboardEvent<HTMLDivElement>){
    if(!selected||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();
    const next=event.key==='Home'?0:event.key==='End'?view.points.length-1:Math.max(0,Math.min(view.points.length-1,index+(event.key==='ArrowLeft'?-1:1)));
    setSelectedAt(view.points[next].at);
  }
  return <section className="listener-history" aria-label="Monthly listener history">
    <div className="history-heading"><span className="tiny">MONTHLY LISTENER HISTORY</span><span className={`history-source ${history.kind==='demo'?'demo':''}`}>{history.kind==='demo'?'DEMO':'OBSERVED'}</span></div>
    <div className="history-ranges" role="group" aria-label="History period">{[7,30,90].map(period=><button key={period} type="button" aria-label={`${period} days`} aria-pressed={days===period} onClick={()=>{setDays(period);setSelectedAt(undefined);}}>{period}D</button>)}</div>
    {selected?<>
      <div className="history-readout"><div><strong className="history-value">{fmt(selected.value)}</strong><span className="history-selected-date">{describe(selected)}</span></div><span className={'history-change '+(view.change!==null&&view.change<0?'negative':'positive')}>{view.change===null?'—':`${view.change>=0?'+':''}${view.change.toFixed(1)}%`}<small>{view.change===null?'need more history':`in this ${days}D view`}</small></span></div>
      <div className="history-graph"><div className="history-y" aria-hidden="true"><span>{compact(view.max)}</span><span>{compact((view.max+view.min)/2)}</span><span>{compact(view.min)}</span></div>
        <div className="history-plot" role={view.points.length>1?'slider':'img'} tabIndex={view.points.length>1?0:undefined} aria-label={view.points.length>1?'Inspect monthly listener history':`One observation: ${fmt(selected.value)} monthly listeners`} aria-describedby={helpId} aria-valuemin={view.points.length>1?0:undefined} aria-valuemax={view.points.length>1?view.points.length-1:undefined} aria-valuenow={view.points.length>1?index:undefined} aria-valuetext={view.points.length>1?`${fmt(selected.value)} monthly listeners, ${describe(selected)}`:undefined} onKeyDown={key} onPointerDown={event=>{inspect(event);event.currentTarget.focus({preventScroll:true});}} onPointerMove={event=>{if(event.pointerType==='mouse'||event.buttons===1)inspect(event);}}>
          <svg viewBox="0 0 500 180" preserveAspectRatio="none" aria-hidden="true"><path className="history-grid" d="M8 16H492M8 90H492M8 164H492"/>{view.segments.map((segment,i)=><g key={i}>{segment.length>1?<polyline className="history-line" vectorEffect="non-scaling-stroke" points={segment.map(p=>`${x(p)},${y(p)}`).join(' ')}/>:<circle cx={x(segment[0])} cy={y(segment[0])} r="3" className="history-dot"/>}</g>)}<path className="history-crosshair" d={`M${x(selected)} 8V172`}/><circle className="history-dot" cx={x(selected)} cy={y(selected)} r="4"/></svg>
        </div>
      </div>
      <div className="history-x tiny"><span>{history.kind==='demo'?`${days}D EARLIER`:date(view.start)}</span><span>{history.kind==='demo'?'LATEST SAMPLE':date(view.end)}</span></div>
    </>:<p className="history-empty">No listener observations in this period yet. Try a wider view.</p>}
    <p id={helpId} className="history-help">{view.points.length>1?'Hover or tap to inspect. Use arrow keys when focused.':view.points.length===1?'One observation so far. More readings are needed to show a trend.':'History begins when valid observations are available.'}</p>
    <p className="history-provenance">{history.kind==='demo'?'Generated demo history — not collected Spotify data.':'Collected Spotify monthly-listener observations. Gaps are left visible.'}</p>
  </section>;
}

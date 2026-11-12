'use client';
import {useEffect,useRef,useState} from 'react';
import type {Artist,Track} from '../types.ts';
import {getPlayback} from '../playback.ts';
import {useApp} from '../state/AppContext.tsx';
import {Icon} from './Primitives.tsx';

interface SoundCloudWidget {bind: (event: string,callback: (data: {id?: number;currentPosition: number})=>void)=>void;unbind: (event: string)=>void;pause: ()=>void;seekTo: (position: number)=>void;getCurrentSound: (callback: (sound: {id?: number})=>void)=>void}
type EventName='READY'|'PLAY'|'PLAY_PROGRESS'|'ERROR';
declare global {interface Window {SC?: {Widget: ((iframe: HTMLIFrameElement)=>SoundCloudWidget)&{Events: Record<EventName,string>}}}}
let api: Promise<void>|undefined;
function loadSoundcloud(){if(window.SC?.Widget)return Promise.resolve();return api ||= new Promise<void>((resolve,reject)=>{const script=document.createElement('script');script.src='https://w.soundcloud.com/player/api.js';script.onload=()=>resolve();script.onerror=()=>{script.remove();api=undefined;reject(Error('Player unavailable'));};document.head.append(script);});}
function SoundCloudPlayer({track,url}: {track: Track;url: string}){
 const iframe=useRef<HTMLIFrameElement>(null),[status,setStatus]=useState('Loading the SoundCloud sound check…');
 useEffect(()=>{let active=true,cleanup: (()=>void)|undefined;
  loadSoundcloud().then(()=>{if(!active||!iframe.current||!window.SC)return;const widget=window.SC.Widget(iframe.current),events=window.SC.Widget.Events;let finished=false;const update=(message: string)=>{if(active)setStatus(message);};
   widget.bind(events.READY,()=>widget.getCurrentSound(sound=>update(sound?.id?'20-second sound check. Press play to listen.':'This SoundCloud embed is unavailable. Open the full track using the link below.')));
   widget.bind(events.PLAY,()=>{if(finished){finished=false;widget.seekTo(0);}update('Sound check · first 20 seconds.');});
   widget.bind(events.PLAY_PROGRESS,event=>{if(event.currentPosition>=20000&&!finished){finished=true;widget.pause();update('Sound check complete. Press play to replay, or hear the full track on SoundCloud.');}});
   widget.bind(events.ERROR,()=>update('SoundCloud could not load this track. Open it directly using the link below.'));
   cleanup=()=>{for(const event of Object.values(events))widget.unbind(event);};
  }).catch(()=>{if(active)setStatus('SoundCloud controls are unavailable. You can still use the player or open the full track below.');});
  return()=>{active=false;cleanup?.();};
 },[track.id]);
 const src=`https://w.soundcloud.com/player/?url=${encodeURIComponent(Number.isSafeInteger(track.soundcloudId)?'https://api.soundcloud.com/tracks/'+track.soundcloudId:url)}&color=%23ff4b33&auto_play=false&hide_related=true&show_comments=false&show_user=true&show_reposts=false&show_teaser=false`;
 return <><iframe ref={iframe} className="soundcloud-player" title={track.title+' on SoundCloud'} height="166" scrolling="no" allow="autoplay; encrypted-media" src={src}/><p className="order-hint" role="status">{status}</p><a href={url} target="_blank" rel="noopener noreferrer" className="text-link">Full track on SoundCloud <Icon name="external" size={15}/></a></>;
}
export function ListenDialog({artist,track}: {artist: Artist;track: Track}){
 const source=getPlayback(track),{openDialog}=useApp();
 return <><span className="eyebrow">THE SOUND CHECK / {artist.name}</span><h2 id="dialog-title">LET IT<br/><em>PLAY OUT.</em></h2><p>{track.title} — {artist.name}</p>{source.provider?<><div className={'recording-note '+('different' in source&&source.different?'different':'')}><strong>{source.label}</strong><p>{source.note}</p></div>{source.provider==='spotify'?<><iframe className="spotify-player" title={`${track.title} by ${artist.name} — Spotify release`} src={source.embedUrl} width="100%" height="152" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="eager"/><p className="order-hint">{track.spotifyPlayability==='COUNTRY_RESTRICTED'?'Spotify reported a regional restriction when this listing was checked. ':''}If the preview won’t play here, open this recording on Spotify. Availability can vary by region and listener.</p><a className="text-link" href={source.url} target="_blank" rel="noopener noreferrer">Open this recording on Spotify <Icon name="external" size={16}/></a></>:<SoundCloudPlayer track={track} url={source.url!}/>}</>:<div className="listen-placeholder"><Icon name="volume" size={38}/><p>{source.note}</p><a className="button light full" href={'https://open.spotify.com/search/'+encodeURIComponent(artist.name+' '+track.title)} target="_blank" rel="noopener noreferrer">Find it on Spotify <Icon name="external" size={18}/></a></div>}<div className="listen-footer"><button className="text-link" onClick={()=>openDialog({type:'order',artistId:artist.id,side:'buy'})}>Believe in {artist.name}? <Icon name="arrow" size={17}/></button></div></>;
}

'use client';
import {useEffect} from 'react';
import {artists} from '../catalog.ts';
import {useApp} from '../state/AppContext.tsx';
import {useNavigation} from '../state/Navigation.tsx';
import {AccountPreview} from '../views/AccountPreview.tsx';
import {AppShell} from './AppShell.tsx';
import {Dialogs} from './Dialogs.tsx';
import {NotFound} from './Primitives.tsx';
import {Artist} from '../views/Artist.tsx';
import {Catalog} from '../views/Catalog.tsx';
import {Collection} from '../views/Collection.tsx';
import {Daily} from '../views/Daily.tsx';
import {Discover} from '../views/Discover.tsx';
import {Receipts,SingleReceipt} from '../views/Receipts.tsx';
export function Application(){
 const {state,ready}=useApp(),{path}=useNavigation(),[page,id]=path.split('/').filter(Boolean);
 useEffect(()=>{document.title=(page==='artist'?(artists.find(a=>a.id===id)?.name||'Artist')+' — ':'')+'FIRST PRESS';},[page,id]);
 if(!ready)return <div className="empty-state" role="status"><span className="eyebrow">FIRST PRESS</span><p>Opening your crate…</p></div>;
 let content;
 switch(page){
  case undefined:case 'discover':content=<Discover/>;break;
  case 'catalog':case 'tracks':content=<Catalog tracks={page==='tracks'}/>;break;
  case 'artist':{const artist=artists.find(a=>a.id===id);content=artist?<Artist key={artist.id} artist={artist}/>:<NotFound/>;break;}
  case 'account':content=<AccountPreview/>;break;
  case 'collection':content=<Collection/>;break;
  case 'daily':content=<Daily/>;break;
  case 'receipts':content=<Receipts/>;break;
  case 'receipt':{const receipt=state.receipts.find(r=>r.id===id);content=receipt?<SingleReceipt receipt={receipt}/>:<NotFound message="This receipt lives on another device, or has been reset."/>;break;}
  default:content=<NotFound/>;
 }
 return <><AppShell>{content}</AppShell><Dialogs/></>;
}

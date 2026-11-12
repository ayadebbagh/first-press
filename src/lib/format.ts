import {artists} from '../catalog.ts';
export const fmt=(n: number)=>new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(n);
export const compact=(n: number)=>new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:1}).format(n);
export const stamp=(n: number)=>String(n).padStart(3,'0');
export const dateLabel=(value: string)=>new Date(value).toLocaleDateString('en-US',{day:'2-digit',month:'short',year:'numeric'});
export const now=()=>new Date().toISOString();
export const day=()=>new Date().toISOString().slice(0,10);
export function byId(id: string){const artist=artists.find(a=>a.id===id);if(!artist)throw Error('Unknown catalog artist');return artist;}

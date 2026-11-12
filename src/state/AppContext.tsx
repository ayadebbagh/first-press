'use client';
import {createContext,useCallback,useContext,useEffect,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import {initialState,loadState,STORAGE_KEY} from '../engine.ts';
import type {BetaState,DialogState} from '../types.ts';

type Update = BetaState | ((previous: BetaState) => BetaState);
interface AppStore {state: BetaState; ready: boolean; storageAvailable: boolean; commit: (next: Update) => void; dialog: DialogState | null; openDialog: (value: DialogState | null) => void; notice: string; toast: (message: string) => void}
const AppContext=createContext<AppStore|null>(null);
export function AppProvider({children,storageKey=STORAGE_KEY}: {children: ReactNode; storageKey?: string}) {
 const [state,setState]=useState<BetaState>(initialState),[ready,setReady]=useState(false),[storageAvailable,setStorageAvailable]=useState(true),[dialog,openDialog]=useState<DialogState|null>(null),[notice,setNotice]=useState('');
 const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
 useEffect(()=>{try{setState(loadState(localStorage.getItem(storageKey)));}catch{setStorageAvailable(false);}setReady(true);},[storageKey]);
 useEffect(()=>{if(!ready)return;try{localStorage.setItem(storageKey,JSON.stringify(state));}catch{setStorageAvailable(false);}},[ready,state,storageKey]);
 useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current);},[]);
 const commit=useCallback((next: Update)=>setState(previous=>typeof next==='function'?next(previous):next),[]);
 const toast=useCallback((message: string)=>{if(timer.current)clearTimeout(timer.current);setNotice(message);timer.current=setTimeout(()=>setNotice(''),4200);},[]);
 return <AppContext.Provider value={{state,ready,storageAvailable,commit,dialog,openDialog,notice,toast}}>{children}</AppContext.Provider>;
}
export function useApp(){const store=useContext(AppContext);if(!store)throw Error('AppProvider is required');return store;}

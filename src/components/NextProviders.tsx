'use client';
import {usePathname,useRouter} from 'next/navigation';
import {useMemo} from 'react';
import type {ReactNode} from 'react';
import {AppProvider} from '../state/AppContext.tsx';
import {NavigationContext} from '../state/Navigation.tsx';
export function NextProviders({children}: {children: ReactNode}){
 const path=usePathname()||'/discover',router=useRouter();
 const navigation=useMemo(()=>({path,navigate:(to: string)=>router.push(to),href:(to: string)=>to}),[path,router]);
 return <AppProvider><NavigationContext.Provider value={navigation}>{children}</NavigationContext.Provider></AppProvider>;
}

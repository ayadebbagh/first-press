'use client';
import {createContext,useContext} from 'react';
import type {AnchorHTMLAttributes,MouseEvent,ReactNode} from 'react';
interface Navigation {path: string; navigate: (path: string)=>void; href: (path: string)=>string}
export const NavigationContext=createContext<Navigation|null>(null);
export function useNavigation(){const value=useContext(NavigationContext);if(!value)throw Error('Navigation provider required');return value;}
export function AppLink({to,children,onClick,...props}: AnchorHTMLAttributes<HTMLAnchorElement>&{to: string;children: ReactNode}){
 const nav=useNavigation();
 function click(event: MouseEvent<HTMLAnchorElement>){onClick?.(event);if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||props.target)return;event.preventDefault();nav.navigate(to);}
 return <a {...props} href={nav.href(to)} onClick={click}>{children}</a>;
}

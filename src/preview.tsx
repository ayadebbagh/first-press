// File-open QA companion. The self-hosted application uses NextProviders instead.
import {createRoot} from 'react-dom/client';
import {useEffect,useMemo,useState} from 'react';
import {Application} from './components/Application.tsx';
import {AppProvider} from './state/AppContext.tsx';
import {NavigationContext} from './state/Navigation.tsx';
function Preview(){
 const [path,setPath]=useState(()=>location.hash.slice(1)||'/discover');
 useEffect(()=>{const update=()=>setPath(location.hash.slice(1)||'/discover');window.addEventListener('hashchange',update);return()=>window.removeEventListener('hashchange',update);},[]);
 const navigation=useMemo(()=>({path,navigate:(to: string)=>{location.hash=to;},href:(to: string)=>'#'+to}),[path]);
 return <AppProvider><NavigationContext.Provider value={navigation}><Application/></NavigationContext.Provider></AppProvider>;
}
createRoot(document.getElementById('app')!).render(<Preview/>);

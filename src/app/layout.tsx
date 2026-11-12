import type {Metadata} from 'next';
import type {ReactNode} from 'react';
import {NextProviders} from '../components/NextProviders.tsx';
import '../style.css';
export const metadata: Metadata={title:'FIRST PRESS — Good ears. Early proof.',description:'Discover the underground. Back the artists you believe in. Keep the receipt.',icons:{icon:'/favicon.svg'}};
export default function RootLayout({children}: {children: ReactNode}){return <html lang="en"><head><link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous"/><link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800;900&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet"/></head><body><div id="app"><NextProviders>{children}</NextProviders></div></body></html>;}

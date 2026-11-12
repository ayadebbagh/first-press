import {notFound,redirect} from 'next/navigation';
import {Application} from '../../components/Application.tsx';
import {artists} from '../../catalog.ts';
export default async function Page({params}: {params: Promise<{path?: string[]}>}){
 const {path=[]}=await params;
 if(!path.length)redirect('/discover');
 const [page,id]=path;
 const single=['discover','catalog','tracks','collection','daily','receipts'].includes(page)&&path.length===1;
 const artist=page==='artist'&&path.length===2&&artists.some(a=>a.id===id);
 const receipt=page==='receipt'&&path.length===2&&/^[A-Za-z0-9-]{1,80}$/.test(id);
 if(!single&&!artist&&!receipt)notFound();
 return <Application/>;
}

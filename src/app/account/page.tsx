import type { Metadata } from 'next';
import Link from 'next/link';
import { AccountPanel } from '../../components/auth/AccountPanel';
import { authConfiguration } from '../../server/auth/config';
export const dynamic='force-dynamic';
export const metadata: Metadata={title:'Your account — FIRST PRESS',referrer:'no-referrer',robots:{index:false,follow:false}};
export default async function AccountPage({searchParams}: {searchParams:Promise<{error?:string;verified?:string}>}) {
  const query=await searchParams;
  let config: ReturnType<typeof authConfiguration>=null;
  try{config=authConfiguration();}catch{console.error('Authentication configuration is incomplete.');}
  return <main className="auth-screen"><header className="auth-header"><Link href="/discover" className="auth-brand">FIRST<br/>PRESS<span>™</span></Link><Link href="/discover">Back to discovery ↗</Link></header><div className="auth-grid"><aside><span className="auth-kicker">GOOD EARS. EARLY PROOF.</span><h1>KEEP <br/>YOUR <br/><em>PLACE.</em></h1><p>Your taste deserves a record.</p><span className="auth-stamp" aria-hidden="true">✳</span></aside><div>{query.error&&<p className="auth-alert" role="alert">Sign-in could not finish. Use your invited email; if it already has an account, sign in there first to connect Google.</p>}{query.verified&&<p className="auth-alert" role="status">Email verified. You can sign in now.</p>}<AccountPanel enabled={Boolean(config)} google={Boolean(config?.google)}/></div></div><footer className="auth-footer">FIRST PRESS / INDEPENDENT TASTE, ALWAYS.</footer></main>;
}

import type { Metadata } from 'next';
import Link from 'next/link';
import { ResetPasswordForm } from '../../components/auth/ResetPasswordForm';
export const dynamic='force-dynamic';
export const metadata: Metadata={title:'Reset password — FIRST PRESS',referrer:'no-referrer',robots:{index:false,follow:false}};
export default async function ResetPage({searchParams}: {searchParams:Promise<{token?:string}>}) {
  const {token}=await searchParams;
  return <main className="auth-screen"><header className="auth-header"><Link href="/discover" className="auth-brand">FIRST<br/>PRESS<span>™</span></Link><Link href="/account">Back to your account ↗</Link></header><div className="auth-reset"><ResetPasswordForm token={token&&/^[A-Za-z0-9_-]{10,500}$/.test(token)?token:null}/></div></main>;
}

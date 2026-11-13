'use client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { createAuthClient } from 'better-auth/react';
import { BackingPanel } from './BackingPanel';
const authClient = createAuthClient();

export function AccountPanel({ enabled, google }: { enabled: boolean; google: boolean }) {
  if (!enabled) return <div className="auth-paper"><h2>Accounts are on their way.</h2><p>This preview still saves demo activity on your device. Connected beta sign-in has not been enabled on this host.</p><a className="auth-button" href="/discover">Explore the demo ↗</a></div>;
  return <SessionPanel google={google}/>;
}
function SessionPanel({ google }: { google: boolean }) {
  const { data: session, isPending, error, refetch } = authClient.useSession();
  const [mode,setMode] = useState<'signin'|'signup'|'forgot'>('signin');
  const [busy,setBusy] = useState(false), [message,setMessage] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage('');
    const form = new FormData(event.currentTarget), email=String(form.get('email')||'').trim();
    try {
      if (mode==='forgot') {
        const result = await authClient.requestPasswordReset({ email, redirectTo:'/reset-password' });
        setMessage(result.error ? 'Could not request a link. Please try again shortly.' : 'If this email has an account, a reset link will arrive. Check your inbox.');
      } else if (mode==='signup') {
        const result = await authClient.signUp.email({ email, password:String(form.get('password')||''), name:String(form.get('name')||'').trim(), callbackURL:'/account?verified=true' });
        setMessage(result.error ? 'Could not create an account. Check your details or try again shortly.' : 'If your email has an active invitation, check your inbox to verify it. Then sign in.');
      } else {
        const result = await authClient.signIn.email({ email, password:String(form.get('password')||''), callbackURL:'/account' });
        if (result.error) setMessage('Could not sign in. Check your details and verify your email first.');
        else await refetch();
      }
    } catch { setMessage('The account service is unavailable. Please try again shortly.'); }
    finally { setBusy(false); }
  }
  async function social(link = false) {
    setBusy(true);setMessage('');
    try {
      const result = link ? await authClient.linkSocial({ provider:'google', callbackURL:'/account' }) : await authClient.signIn.social({ provider:'google', callbackURL:'/account', errorCallbackURL:'/account?error=oauth' });
      if (result.error) setMessage('Google sign-in could not start. Try again shortly.');
    } catch { setMessage('Google sign-in is unavailable.'); }
    finally { setBusy(false); }
  }
  if (isPending) return <div className="auth-paper" role="status">Checking your session…</div>;
  if (error) return <div className="auth-paper"><h2>Temporarily off the record.</h2><p>We could not reach the account service.</p><button className="auth-button" onClick={()=>refetch()}>Try again</button></div>;
  if (session) return <div className="connected-account-stack"><div className="auth-paper"><span className="auth-kicker">CONNECTED ACCOUNT</span><h2>Good to see you,<br/>{session.user.name}.</h2><p className="auth-email">{session.user.email}</p><p>Your identity is saved on the server. Manage your server wallet and queued backing below. The demo’s Credits and collection stay on this device.</p><ProfileForm name={session.user.name} onSaved={()=>refetch()}/>{google&&<button className="auth-secondary" disabled={busy} onClick={()=>social(true)}>Connect Google to this account ↗</button>}<button className="auth-secondary" disabled={busy} onClick={async()=>{setBusy(true);try{const result=await authClient.signOut();if(result.error)setMessage('Could not sign out. Please try again.');else await refetch();}catch{setMessage('Could not sign out. Please try again.');}finally{setBusy(false);}}}>Sign out</button><p role="status">{message}</p></div><BackingPanel key={session.user.id} userId={session.user.id}/></div>;
  return <div className="auth-paper"><span className="auth-kicker">INVITE-ONLY BETA / 001</span><h2>{mode==='signup'?'Get on record.':mode==='forgot'?'Find your way back.':'Your ears. Your account.'}</h2><p>{mode==='signup'?'Use the email address that was invited. Verify it before your first sign-in.':mode==='forgot'?'We’ll send a short-lived link if there’s an account for your email.':'Sign in to your connected beta account.'}</p>
    {mode!=='forgot'&&google&&<><button className="auth-google" onClick={()=>social()} disabled={busy}>Continue with Google ↗</button><span className="auth-divider">OR USE EMAIL</span></>}
    <form onSubmit={submit}>
      {mode==='signup'&&<label>Display name<input name="name" required minLength={1} maxLength={50} autoComplete="nickname"/></label>}
      <label>Email<input name="email" type="email" required maxLength={254} autoComplete="email"/></label>
      {mode!=='forgot'&&<label>Password<input name="password" type="password" required minLength={mode==='signup'?12:1} maxLength={128} autoComplete={mode==='signup'?'new-password':'current-password'} aria-describedby={mode==='signup'?'password-help':undefined}/></label>}{mode==='signup'&&<small id="password-help">At least 12 characters.</small>}
      <button className="auth-button" disabled={busy} type="submit">{busy?'One moment…':mode==='signup'?'Create account ↗':mode==='forgot'?'Send reset link ↗':'Sign in ↗'}</button>
    </form>
    <p className="auth-message" role="status">{message}</p>
    <div className="auth-links"><button disabled={busy} onClick={()=>{setMode(mode==='signup'?'signin':'signup');setMessage('');}}>{mode==='signup'?'Already on record? Sign in':'Have an invitation? Create account'}</button><button disabled={busy} onClick={()=>{setMode(mode==='forgot'?'signin':'forgot');setMessage('');}}>{mode==='forgot'?'Back to sign-in':'Forgot password?'}</button></div>
    <p className="auth-small">Using Google with an existing email account? Sign in with email first, then connect Google from your account. Google members can use password recovery to add an email password.</p>
  </div>;
}
function ProfileForm({ name, onSaved }: { name: string; onSaved: ()=>void }) {
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();setBusy(true);setMessage('');
    try {
      const name=String(new FormData(event.currentTarget).get('name')||'').trim();
      const result=await fetch('/api/account/profile',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
      if(!result.ok) throw Error();
      setMessage('Display name saved.');onSaved();
    } catch {setMessage('Could not save your display name. Please try again.');}
    finally {setBusy(false);}
  }
  return <form onSubmit={save} className="auth-profile"><label>Display name<input name="name" defaultValue={name} required maxLength={50} autoComplete="nickname"/></label><button className="auth-button" disabled={busy}>Save display name ↗</button><p role="status">{message}</p></form>;
}

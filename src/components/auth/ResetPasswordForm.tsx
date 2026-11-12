'use client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { createAuthClient } from 'better-auth/react';
const authClient=createAuthClient();
export function ResetPasswordForm({ token }: { token: string | null }) {
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[done,setDone]=useState(false);
  if (!token) return <div className="auth-paper"><h2>This link needs a new pressing.</h2><p>The reset link is missing or expired. Request another from your account page.</p><a className="auth-button" href="/account">Back to sign-in ↗</a></div>;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();setBusy(true);setMessage('');
    const form=new FormData(event.currentTarget),password=String(form.get('password')||'');
    if(password!==form.get('confirm')){setMessage('Your passwords do not match.');setBusy(false);return;}
    try{
      const result=await authClient.resetPassword({token:token!,newPassword:password});
      if(result.error)setMessage('This link is invalid or expired. Request a new reset link.');
      else{setDone(true);history.replaceState(null,'','/reset-password');}
    }catch{setMessage('Could not reset your password. Please try again.');}
    finally{setBusy(false);}
  }
  return <div className="auth-paper"><h2>{done?'Back in rotation.':'A fresh password.'}</h2>{done?<><p>Your password is updated and previous sessions are signed out.</p><a className="auth-button" href="/account">Sign in ↗</a></>:<form onSubmit={submit}><label>New password<input name="password" type="password" minLength={12} maxLength={128} required autoComplete="new-password"/></label><label>Confirm password<input name="confirm" type="password" required autoComplete="new-password"/></label><button className="auth-button" disabled={busy}>{busy?'Saving…':'Set password ↗'}</button></form>}<p role="status">{message}</p></div>;
}

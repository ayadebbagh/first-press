import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { databaseClient } from '../db/connection.mjs';
const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  email: { type:'string' }, actor: { type:'string' }, reason: { type:'string' },
  role: { type:'string' }, status: { type:'string' }, revoke: { type:'boolean', default:false },
} });
const [action] = positionals, email = values.email?.trim().toLowerCase();
if (!['invite','member'].includes(action) || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length>254 ||
  !values.actor || !values.reason || values.reason.trim().length<3 ||
  (values.role && !['member','admin'].includes(values.role)) || (values.status && !['active','suspended'].includes(values.status))) {
  console.error('Use invite|member --email ADDRESS --actor OPERATOR --reason REASON [--revoke | --role member|admin | --status active|suspended].');
  process.exit(1);
}
const client = databaseClient();
try {
  await client.connect(); await client.query('BEGIN');
  if (action==='invite') {
    if (values.revoke) await client.query('UPDATE beta_invites SET revoked_at=now() WHERE email=$1', [email]);
    else await client.query(`INSERT INTO beta_invites(email,created_by,expires_at) VALUES ($1,$2,now()+interval '7 days')
      ON CONFLICT(email) DO UPDATE SET expires_at=EXCLUDED.expires_at,revoked_at=NULL
      WHERE beta_invites.claimed_by IS NULL`, [email, values.actor]);
  } else {
    if (!values.role && !values.status) throw new Error('No member change specified.');
    const result = await client.query(`UPDATE members SET role=coalesce($2,role),status=coalesce($3,status)
      WHERE user_id=(SELECT id FROM "user" WHERE email=$1) RETURNING user_id`, [email,values.role??null,values.status??null]);
    if (result.rowCount!==1) throw new Error('Member not found.');
  }
  await client.query('INSERT INTO auth_audit_events(id,actor,action,target,reason) VALUES ($1,$2,$3,$4,$5)',
    [randomUUID(),values.actor,action==='invite'?(values.revoke?'invite_revoked':'invite_created'):'member_access_changed',email,values.reason.trim()]);
  await client.query('COMMIT'); console.log('Access change recorded. No email was sent.');
} catch {
  await client.query('ROLLBACK').catch(()=>{}); console.error('Access change failed; no changes committed.'); process.exitCode=1;
} finally { await client.end(); }

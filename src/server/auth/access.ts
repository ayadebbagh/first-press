import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { getDatabase } from '../db/client';
import { members } from '../db/schema';
import { getAuthentication } from './runtime';

export class AccessError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export async function requireMember(headers: Headers) {
  const auth = getAuthentication();
  if (!auth) throw new AccessError(503, 'Connected accounts are not configured.');
  const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
  if (!session || !session.user.emailVerified) throw new AccessError(401, 'Sign in to continue.');
  const [member] = await getDatabase().select().from(members).where(and(eq(members.userId, session.user.id), eq(members.status, 'active')));
  if (!member) throw new AccessError(403, 'This account is unavailable.');
  return { user: session.user, member };
}
export async function requireAdmin(headers: Headers) {
  const identity = await requireMember(headers);
  if (identity.member.role !== 'admin') throw new AccessError(403, 'Admin access required.');
  return identity;
}
export function requireSameOrigin(request: Request) {
  const expected = process.env.BETTER_AUTH_URL;
  if (!expected || request.headers.get('origin') !== new URL(expected).origin) throw new AccessError(403, 'Request origin is not allowed.');
}
export function privateJson(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
}
export async function accountResponse(action: () => Promise<Response>) {
  try { return await action(); }
  catch (error) {
    if (error instanceof AccessError) return privateJson({ error: error.message }, error.status);
    console.error('Account request failed.');
    return privateJson({ error: 'Account service is temporarily unavailable.' }, 503);
  }
}

export async function limitMemberAction(userId: string, action: string, max: number, seconds: number) {
  const result = await getDatabase().execute(sql`
    INSERT INTO action_limits(key,count,window_started_at) VALUES (${action + ':' + userId},1,now())
    ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN action_limits.window_started_at<=now()-make_interval(secs=>${seconds}) THEN 1 ELSE least(action_limits.count+1,${max+1}) END,
      window_started_at=CASE WHEN action_limits.window_started_at<=now()-make_interval(secs=>${seconds}) THEN now() ELSE action_limits.window_started_at END
    RETURNING count`);
  if (Number(result.rows[0].count)>max) throw new AccessError(429, 'Too many requests. Try again later.');
}

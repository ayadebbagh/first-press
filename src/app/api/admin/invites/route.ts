import { randomUUID } from 'node:crypto';
import { accountResponse, privateJson, requireAdmin, requireSameOrigin, limitMemberAction, AccessError } from '../../../../server/auth/access';
import { getDatabase } from '../../../../server/db/client';
import { betaInvites, authAuditEvents } from '../../../../server/db/schema';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  return accountResponse(async () => {
    requireSameOrigin(request);
    const { user } = await requireAdmin(request.headers);
    await limitMemberAction(user.id, 'invite', 10, 3600);
    const data = await request.json();
    if (!data || Object.keys(data).some(key=>!['email','reason'].includes(key)) ||
      typeof data.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim()) || data.email.length>254 ||
      typeof data.reason !== 'string' || data.reason.trim().length<3 || data.reason.length>500) throw new AccessError(400, 'Email and reason are required.');
    const email = data.email.trim().toLowerCase();
    await getDatabase().transaction(async tx => {
      await tx.insert(betaInvites).values({ email, createdBy: user.id, expiresAt: new Date(Date.now()+7*86400_000) });
      await tx.insert(authAuditEvents).values({ id: randomUUID(), actor: user.id, action: 'invite_created', target: email, reason: data.reason.trim() });
    });
    return privateJson({ status: 'invited' }, 201);
  });
}

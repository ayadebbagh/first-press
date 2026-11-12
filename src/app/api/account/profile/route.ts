import { eq } from 'drizzle-orm';
import { accountResponse, privateJson, requireMember, requireSameOrigin, limitMemberAction, AccessError } from '../../../../server/auth/access';
import { getDatabase } from '../../../../server/db/client';
import { members, user } from '../../../../server/db/schema';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return accountResponse(async () => {
    const identity = await requireMember(request.headers);
    return privateJson({ id: identity.user.id, name: identity.user.name, email: identity.user.email,
      role: identity.member.role, publicProfile: identity.member.publicProfile, mode: 'connected-identity' });
  });
}
export async function PATCH(request: Request) {
  return accountResponse(async () => {
    requireSameOrigin(request);
    const identity = await requireMember(request.headers);
    await limitMemberAction(identity.user.id, 'profile', 20, 60);
    const input: unknown = await request.json();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AccessError(400, 'Invalid profile.');
    const data = input as Record<string, unknown>;
    if (Object.keys(data).some(key => !['name', 'publicProfile'].includes(key)) ||
      (data.name !== undefined && (typeof data.name !== 'string' || data.name.trim().length < 1 || data.name.trim().length > 50)) ||
      (data.publicProfile !== undefined && typeof data.publicProfile !== 'boolean')) throw new AccessError(400, 'Invalid profile fields.');
    await getDatabase().transaction(async tx => {
      if (typeof data.name === 'string') await tx.update(user).set({ name: data.name.trim() }).where(eq(user.id, identity.user.id));
      if (typeof data.publicProfile === 'boolean') await tx.update(members).set({ publicProfile: data.publicProfile }).where(eq(members.userId, identity.user.id));
    });
    return privateJson({ status: 'updated' });
  });
}

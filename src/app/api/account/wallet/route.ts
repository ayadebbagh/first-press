import { eq } from 'drizzle-orm';
import { accountResponse, privateJson, requireMember } from '../../../../server/auth/access';
import { getDatabase } from '../../../../server/db/client';
import { wallets } from '../../../../server/db/schema';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return accountResponse(async () => {
    const { user } = await requireMember(request.headers);
    const [wallet] = await getDatabase().select().from(wallets).where(eq(wallets.userId, user.id));
    return privateJson({ wallet: wallet ? { availableCents: wallet.availableCents.toString(), reservedCents: wallet.reservedCents.toString() } : null });
  });
}

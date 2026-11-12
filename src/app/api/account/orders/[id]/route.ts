import { and, eq } from 'drizzle-orm';
import { accountResponse, privateJson, requireMember } from '../../../../../server/auth/access';
import { getDatabase } from '../../../../../server/db/client';
import { orders } from '../../../../../server/db/schema';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return accountResponse(async () => {
    const { user } = await requireMember(request.headers), { id } = await params;
    const [order] = await getDatabase().select().from(orders).where(and(eq(orders.id, id), eq(orders.userId, user.id)));
    if (!order) return privateJson({ error: 'Order not found.' }, 404);
    return privateJson({ id: order.id, artistId: order.artistId, side: order.side, status: order.status,
      amountCents: order.amountCents?.toString() ?? null, acceptedAt: order.acceptedAt.toISOString() });
  });
}

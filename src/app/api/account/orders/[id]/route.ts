import { privateJson, requireMember, limitMemberAction } from '../../../../../server/auth/access';
import { getDatabase } from '../../../../../server/db/client';
import { getOrder } from '../../../../../server/backing/buy-orders';
import { orderResponse } from '../../../../../server/backing/http';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return orderResponse(async () => {
    const { user } = await requireMember(request.headers), { id } = await params;
    await limitMemberAction(user.id,'order-read',60,60);
    return privateJson(await getOrder(getDatabase(),user.id,id));
  });
}

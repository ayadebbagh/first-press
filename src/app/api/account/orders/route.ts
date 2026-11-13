import { requireMember, requireSameOrigin, limitMemberAction, privateJson } from '../../../../server/auth/access';
import { getDatabase } from '../../../../server/db/client';
import { placeBuy } from '../../../../server/backing/buy-orders';
import { backingBody, orderResponse } from '../../../../server/backing/http';
export const dynamic='force-dynamic';
export async function POST(request:Request){
  return orderResponse(async()=>{
    requireSameOrigin(request);const {user}=await requireMember(request.headers);
    await limitMemberAction(user.id,'buy-place',30,60);
    const result=await placeBuy(getDatabase(),user.id,await backingBody(request));
    return privateJson(result,result.created?201:200);
  });
}

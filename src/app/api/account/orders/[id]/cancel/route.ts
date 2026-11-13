import { requireMember, requireSameOrigin, limitMemberAction, privateJson } from '../../../../../../server/auth/access';
import { getDatabase } from '../../../../../../server/db/client';
import { cancelBuy } from '../../../../../../server/backing/buy-orders';
import { backingBody, orderResponse } from '../../../../../../server/backing/http';
export const dynamic='force-dynamic';
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
  return orderResponse(async()=>{
    requireSameOrigin(request);const {user}=await requireMember(request.headers),{id}=await params;
    await limitMemberAction(user.id,'buy-cancel',60,60);await backingBody(request,true);
    return privateJson(await cancelBuy(getDatabase(),user.id,id));
  });
}

import { requireMember, limitMemberAction, privateJson } from '../../../../server/auth/access';
import { getDatabase } from '../../../../server/db/client';
import { getBackingDesk } from '../../../../server/backing/buy-orders';
import { orderResponse } from '../../../../server/backing/http';
export const dynamic='force-dynamic';
export async function GET(request:Request){
  return orderResponse(async()=>{
    const {user}=await requireMember(request.headers);await limitMemberAction(user.id,'backing-read',60,60);
    return privateJson(await getBackingDesk(getDatabase(),user.id,new URL(request.url).searchParams.get('cursor')??undefined));
  });
}

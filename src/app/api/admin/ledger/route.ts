import { accountResponse, privateJson, requireAdmin, limitMemberAction, AccessError } from '../../../../server/auth/access';
import { getDatabase } from '../../../../server/db/client';
import { reconcileWallet } from '../../../../server/backing/ledger';
export const dynamic='force-dynamic';
export async function GET(request: Request){
  return accountResponse(async()=>{
    const {user}=await requireAdmin(request.headers);
    await limitMemberAction(user.id,'ledger-diagnostic',30,60);
    const target=new URL(request.url).searchParams.get('userId')??user.id;
    if(!target||target.length>200)throw new AccessError(400,'Invalid account identifier.');
    const report=await reconcileWallet(getDatabase(),target);
    if(!report)return privateJson({error:'Account not found.'},404);
    return privateJson(report);
  });
}

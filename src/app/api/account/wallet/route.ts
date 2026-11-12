import { initializeWallet, walletWire, LedgerError } from '../../../../server/backing/ledger';
import { eq } from 'drizzle-orm';
import { accountResponse, privateJson, requireMember, requireSameOrigin, limitMemberAction, AccessError } from '../../../../server/auth/access';
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

// Explicit POST keeps GET side-effect free. Recipient and grant size are server-owned.
export async function POST(request: Request){
  return accountResponse(async()=>{
    requireSameOrigin(request);
    const {user}=await requireMember(request.headers);
    await limitMemberAction(user.id,'wallet-initialize',10,60);
    const body=await request.text();
    if(body.length>1024)throw new AccessError(413,'Wallet initialization takes no account or amount fields.');
    let input: unknown;
    try{input=body.trim()?JSON.parse(body):{};}catch{throw new AccessError(400,'Invalid wallet request.');}
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw new AccessError(400,'Wallet initialization takes no account or amount fields.');
    try{
      const result=await initializeWallet(getDatabase(),user.id);
      return privateJson({wallet:walletWire(result.wallet),startingGrantEventId:result.eventId,created:result.created},result.created?201:200);
    }catch(error){
      if(error instanceof LedgerError)throw new AccessError(error.code==='ineligible'?403:error.code==='drift'?409:400,error.message);
      throw error;
    }
  });
}

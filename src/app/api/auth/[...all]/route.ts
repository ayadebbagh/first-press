import { getAuthentication } from '../../../../server/auth/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function handler(request: Request) {
  try {
    const auth = getAuthentication();
    if (!auth) return Response.json({ error: 'Connected accounts are not configured.' }, { status: 503 });
    const response = await auth.handler(request);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch {
    console.error('Authentication request failed.');
    return Response.json({ error: 'Authentication is temporarily unavailable.' }, { status: 503 });
  }
}
export { handler as GET, handler as POST };

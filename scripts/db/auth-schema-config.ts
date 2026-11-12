// Schema generation only. No auth routes, credentials or network connections.
// Runtime admission, providers and verification are in src/server/auth/core.ts.
import { betterAuth } from 'better-auth';
export const auth = betterAuth({
  rateLimit: { enabled: true, storage: 'database' },
  emailAndPassword: { enabled: true, requireEmailVerification: true },
});

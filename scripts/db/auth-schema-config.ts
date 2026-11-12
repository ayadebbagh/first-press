// Schema generation only. No auth routes, credentials or network connections.
// A02 owns invite admission, providers, email verification and runtime config.
import { betterAuth } from 'better-auth';
export const auth = betterAuth({
  rateLimit: { enabled: true, storage: 'database' },
  emailAndPassword: { enabled: true, requireEmailVerification: true },
});

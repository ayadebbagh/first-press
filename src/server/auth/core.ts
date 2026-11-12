import { randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema.ts';
import type { AuthConfiguration } from './config.ts';

export function createAuthentication(db: NodePgDatabase<typeof schema>, config: AuthConfiguration) {
  async function queueMail(to: string, url: string, purpose: 'verification' | 'reset') {
    const parsed = new URL(url);
    if (parsed.origin !== config.baseURL) throw new Error('Authentication email has an unexpected origin.');
    await db.insert(schema.mailOutbox).values({ id: randomUUID(), recipient: to, purpose,
      subject: purpose === 'reset' ? 'Reset your FIRST PRESS password' : 'Verify your FIRST PRESS email',
      body: `FIRST PRESS\n\n${purpose === 'reset' ? 'Reset your password' : 'Verify your email'}:\n${url}\n\nThis link expires in 30 minutes. If you did not request it, ignore this email.`,
      expiresAt: new Date(Date.now() + 30 * 60_000) });
  }
  return betterAuth({
    appName: 'FIRST PRESS',
    baseURL: config.baseURL,
    secret: config.secret,
    database: drizzleAdapter(db, { provider: 'pg', schema, transaction: true }),
    emailAndPassword: {
      enabled: true, minPasswordLength: 12, maxPasswordLength: 128,
      requireEmailVerification: true, autoSignIn: false,
      resetPasswordTokenExpiresIn: 30 * 60, revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, url }) => queueMail(user.email, url, 'reset'),
    },
    emailVerification: {
      sendOnSignUp: true, sendOnSignIn: true, autoSignInAfterVerification: false,
      expiresIn: 30 * 60,
      sendVerificationEmail: ({ user, url }) => queueMail(user.email, url, 'verification'),
    },
    socialProviders: config.google ? { google: { ...config.google, prompt: 'select_account' } } : {},
    account: { accountLinking: { enabled: true, disableImplicitLinking: true, allowDifferentEmails: false, requireLocalEmailVerified: true } },
    session: { expiresIn: 7 * 24 * 60 * 60, updateAge: 24 * 60 * 60, freshAge: 15 * 60, cookieCache: { enabled: false } },
    user: { changeEmail: { enabled: false }, deleteUser: { enabled: false } },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/sign-up/email': { window: 60, max: 3 },
        '/request-password-reset': { window: 60, max: 3 },
        '/send-verification-email': { window: 60, max: 3 },
        '/sign-in/social': { window: 60, max: 10 },
      } },
    advanced: {
      useSecureCookies: config.baseURL.startsWith('https:'),
      ipAddress: { ipAddressHeaders: config.ipAddressHeaders },
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
    },
    // Database triggers admit all user-creation paths and atomically claim invites.
    // This extra gate prevents both email and social logins for suspended members.
    databaseHooks: { user: { create: { before: async candidate => {
      const [invite] = await db.select({ email: schema.betaInvites.email }).from(schema.betaInvites)
        .where(and(eq(schema.betaInvites.email, candidate.email.trim().toLowerCase()),
          gt(schema.betaInvites.expiresAt, new Date()), isNull(schema.betaInvites.revokedAt), isNull(schema.betaInvites.claimedBy)));
      if (!invite) throw new APIError('FORBIDDEN', { message: 'Beta admission is unavailable.' });
    } } }, session: { create: { before: async session => {
      const [member] = await db.select({ id: schema.members.userId }).from(schema.members)
        .innerJoin(schema.user, eq(schema.members.userId, schema.user.id))
        .where(and(eq(schema.members.userId, session.userId), eq(schema.members.status, 'active'), eq(schema.user.emailVerified, true)));
      if (!member) throw new APIError('FORBIDDEN', { message: 'This account cannot sign in.' });
    } } } },
    // Never log email addresses, reset links, provider tokens or credential failures.
    logger: { disabled: true },
  });
}

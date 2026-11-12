export interface AuthConfiguration {
  baseURL: string;
  secret: string;
  google?: { clientId: string; clientSecret: string };
  ipAddressHeaders: string[];
}

export function authConfiguration(env: NodeJS.ProcessEnv = process.env): AuthConfiguration | null {
  if (env.FIRST_PRESS_AUTH_ENABLED !== 'true') return null;
  if (!env.DATABASE_URL || !env.BETTER_AUTH_URL || !env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) {
    throw new Error('Authentication needs a database, canonical URL and a secret of at least 32 characters.');
  }
  const base = new URL(env.BETTER_AUTH_URL);
  if (base.username || base.password || base.pathname !== '/' || base.search || base.hash ||
    (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname)))) {
    throw new Error('Authentication URL must be an HTTPS origin (HTTP is allowed on loopback only).');
  }
  if (Boolean(env.GOOGLE_CLIENT_ID) !== Boolean(env.GOOGLE_CLIENT_SECRET)) throw new Error('Both Google OAuth credentials are required.');
  // Default to a shared bucket. Only trust a header the private reverse proxy
  // overwrites; a client-supplied X-Forwarded-For is not a rate-limit identity.
  const ipAddressHeaders = env.AUTH_TRUSTED_IP_HEADER ? [env.AUTH_TRUSTED_IP_HEADER.toLowerCase()] : [];
  if (ipAddressHeaders.some(h => !/^[a-z0-9-]+$/.test(h))) throw new Error('Invalid trusted client-IP header.');
  return { baseURL: base.origin, secret: env.BETTER_AUTH_SECRET,
    google: env.GOOGLE_CLIENT_ID ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET! } : undefined,
    ipAddressHeaders };
}

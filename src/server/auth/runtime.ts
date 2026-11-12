import 'server-only';
import { getDatabase } from '../db/client';
import { authConfiguration } from './config';
import { createAuthentication } from './core';
let instance: ReturnType<typeof createAuthentication> | undefined;
export function getAuthentication() {
  const config = authConfiguration();
  if (!config) return null;
  instance ??= createAuthentication(getDatabase(), config);
  return instance;
}

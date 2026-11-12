import {test} from 'node:test';
import assert from 'node:assert/strict';
import {authConfiguration} from '../src/server/auth/config.ts';
const env={FIRST_PRESS_AUTH_ENABLED:'true',DATABASE_URL:'postgresql://fixture/fixture',BETTER_AUTH_URL:'http://127.0.0.1:3101',BETTER_AUTH_SECRET:'isolated-configuration-test-secret-123456'};
test('auth is explicitly gated and refuses weak secrets, untrusted origins and incomplete provider credentials',()=>{
  assert.equal(authConfiguration({}),null);
  assert.deepEqual(authConfiguration(env).ipAddressHeaders,[]);
  for(const update of [{BETTER_AUTH_SECRET:'short'},{BETTER_AUTH_URL:'http://public.invalid'},{BETTER_AUTH_URL:'https://user:password@example.invalid'},{BETTER_AUTH_URL:'https://example.invalid/path'},{GOOGLE_CLIENT_ID:'alone'}])assert.throws(()=>authConfiguration({...env,...update}));
  assert.equal(authConfiguration({...env,BETTER_AUTH_URL:'https://beta.example.invalid'}).baseURL,'https://beta.example.invalid');
});

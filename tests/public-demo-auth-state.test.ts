import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeDotsOnlyStorageState } from './e2e/public-demo-auth-state.ts';

const origin = new URL('https://codex.cokeagent.com/dots-demo/');
const baseCookie = {
  name: 'coke_dots_session', value: 'private-session-token', domain: '.cokeagent.com', path: '/dots-demo',
  expires: 1_900_000_000, httpOnly: true, secure: true, sameSite: 'Lax' as const,
};

test('public E2E setup persists only a host-only Coke Dots session cookie', () => {
  const state = makeDotsOnlyStorageState({
    cookies: [
      { ...baseCookie, name: 'google_identity', value: 'private-google-cookie' },
      { ...baseCookie, name: 'coke_dots_session', value: 'private-wrong-path', path: '/' },
      baseCookie,
      { ...baseCookie, name: 'other_app_session', value: 'private-other-app-cookie' },
    ],
    origins: [{ origin: 'https://codex.cokeagent.com', localStorage: [{ name: 'private-app-token', value: 'private-local-storage-token' }] }],
  }, origin, '/dots-demo/');

  assert.deepEqual(state, { cookies: [{ ...baseCookie, domain: 'codex.cokeagent.com' }], origins: [] });
  const serialized = JSON.stringify(state);
  assert.doesNotMatch(serialized, /private-google-cookie|private-other-app-cookie|private-local-storage-token/);
});

test('public E2E setup rejects missing, insecure, or wrong-path Dots session cookies', () => {
  const wrongPath = { ...baseCookie, path: '/' };
  assert.throws(() => makeDotsOnlyStorageState({ cookies: [wrongPath], origins: [] }, origin, '/dots-demo/'), /No Coke Dots session cookie/);
  assert.throws(() => makeDotsOnlyStorageState({ cookies: [{ ...baseCookie, secure: false }], origins: [] }, origin, '/dots-demo/'), /expected secure/);
});

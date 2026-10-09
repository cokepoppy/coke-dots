import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Entry } from '@napi-rs/keyring';
import { Store } from '../src/server/store.ts';
import { WebsitePasswordVault } from '../src/server/website-passwords.ts';

const testKeychainService = `${process.env.DOTS_KEYCHAIN_SERVICE?.trim() || 'com.cokepoppy.coke-dots.test'}.website-passwords-${process.pid}-${randomUUID()}`;
process.env.DOTS_KEYCHAIN_SERVICE = testKeychainService;

test('saved website passwords stay in Keychain and can only be reused by their owner in a personal Dot task', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-website-passwords-'));
  const store = new Store(directory);
  const vault = new WebsitePasswordVault(store);
  const alpha = store.signInGoogle({ subject: randomUUID(), email: 'website-alpha@example.test', name: 'Alpha' });
  const beta = store.signInGoogle({ subject: randomUUID(), email: 'website-beta@example.test', name: 'Beta' });
  let keychainAccount = '';
  try {
    const firstTask = store.createTask('Authenticate to review the private dashboard', null, 'model', alpha.tenant.id, null, null, [], alpha.user.id);
    assert.equal(store.canUseSavedWebsiteLogin(alpha.tenant.id, firstTask.id, alpha.user.id), true);
    assert.equal(store.canUseSavedWebsiteLogin(beta.tenant.id, firstTask.id, beta.user.id), false);

    const saved = await vault.save(alpha.user.id, 'LOGIN-FIXTURE.DOTS.TEST', 'alpha@example.test', 'fixture-password-not-for-production');
    assert.equal(saved.hostname, 'login-fixture.dots.test');
    assert.deepEqual(vault.list(alpha.user.id, 'login-fixture.dots.test').map(login => ({ ...login })), [saved]);
    assert.deepEqual(vault.loadForUse(alpha.user.id, saved.id, 'login-fixture.dots.test'), {
      username: 'alpha@example.test', password: 'fixture-password-not-for-production',
    });
    assert.equal(vault.loadForUse(alpha.user.id, saved.id, 'another-site.example'), null, 'A saved login must match the exact requested host');
    assert.equal(vault.loadForUse(beta.user.id, saved.id, 'login-fixture.dots.test'), null, 'Another Google account cannot retrieve the secret');
    assert.deepEqual(vault.list(beta.user.id, 'login-fixture.dots.test'), [], 'Another Google account cannot see its metadata');

    const shared = store.createWorkspace(alpha.user.id, 'Shared website task test');
    store.db.prepare('INSERT INTO memberships(tenant_id,user_id,role,created_at) VALUES (?,?,?,?)')
      .run(shared.id, beta.user.id, 'member', new Date().toISOString());
    const sharedTask = store.createTask('Review the shared account dashboard', null, 'model', shared.id, null, null, [], alpha.user.id);
    assert.equal(store.canUseSavedWebsiteLogin(shared.id, sharedTask.id, alpha.user.id), false, 'Saved personal credentials are unavailable in a shared workspace');
    assert.equal(store.canUseSavedWebsiteLogin(shared.id, sharedTask.id, beta.user.id), false, 'A workspace member cannot reuse another account’s password');

    const metadataRows = store.db.prepare('SELECT id,user_id,hostname,username,keychain_account FROM saved_website_logins').all();
    assert.equal(JSON.stringify(metadataRows).includes('fixture-password-not-for-production'), false, 'SQLite must contain no website password');
    keychainAccount = (metadataRows[0] as { keychain_account: string }).keychain_account;
    assert.equal(new Entry(testKeychainService, keychainAccount).getPassword(), 'fixture-password-not-for-production', 'The actual OS Keychain entry must hold the password');

    await vault.save(alpha.user.id, 'login-fixture.dots.test', 'alpha@example.test', 'updated-fixture-password');
    assert.equal(vault.list(alpha.user.id, 'login-fixture.dots.test').length, 1, 'Saving an updated password must replace the existing login');
    assert.equal(vault.loadForUse(alpha.user.id, saved.id, 'login-fixture.dots.test')?.password, 'updated-fixture-password');
    assert.equal(await vault.forget(beta.user.id, saved.id), false, 'Another account cannot delete the saved login');
    assert.equal(await vault.forget(alpha.user.id, saved.id), true);
    assert.equal(vault.loadForUse(alpha.user.id, saved.id, 'login-fixture.dots.test'), null);
    assert.equal(store.db.prepare('SELECT id FROM saved_website_logins WHERE id=?').get(saved.id), undefined);
    assert.equal(new Entry(testKeychainService, keychainAccount).getPassword(), null, 'Deleting metadata also removes the OS Keychain secret');
  } finally {
    if (keychainAccount) new Entry(testKeychainService, keychainAccount).deletePassword();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

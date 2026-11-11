// storage.rules scopes assignment attachments to their owner.
import { test, describe, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-studyflow',
    storage: { rules: readFileSync(new URL('../../storage.rules', import.meta.url), 'utf8') },
  });
});
after(() => env.cleanup());
beforeEach(() => env.clearStorage());

const as   = uid => env.authenticatedContext(uid).storage();
const anon = ()  => env.unauthenticatedContext().storage();
const seed = path => env.withSecurityRulesDisabled(ctx => ctx.storage().ref(path).putString('file'));

const ALICE_FILE = 'users/alice/hw-attachments/att-1-notes.pdf';

describe('users/{uid}/hw-attachments/**', () => {
  test('a user can upload, read and delete their own attachments', async () => {
    await assertSucceeds(as('alice').ref(ALICE_FILE).putString('file'));
    await assertSucceeds(as('alice').ref(ALICE_FILE).getMetadata());
    await assertSucceeds(as('alice').ref(ALICE_FILE).delete());
  });

  test('another user can\'t read, overwrite or delete them', async () => {
    await seed(ALICE_FILE);
    await assertFails(as('bob').ref(ALICE_FILE).getMetadata());
    await assertFails(as('bob').ref(ALICE_FILE).putString('replaced'));
    await assertFails(as('bob').ref(ALICE_FILE).delete());
  });

  test('signed-out visitors get nothing', async () => {
    await seed(ALICE_FILE);
    await assertFails(anon().ref(ALICE_FILE).getMetadata());
    await assertFails(anon().ref('users/alice/hw-attachments/new.pdf').putString('x'));
  });

  test('paths outside hw-attachments are denied, even for the owner', async () => {
    await assertFails(as('alice').ref('users/alice/other/file.txt').putString('x'));
    await assertFails(as('alice').ref('public/file.txt').putString('x'));
  });
});

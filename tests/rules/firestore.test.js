// firestore.rules is the app's entire security model — there is no backend
// checking anything. These run against the Firestore emulator; `npm run
// test:rules` starts it, loads the rules, and stops it afterwards.
import { test, describe, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-studyflow',
    firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
  });
});
after(() => env.cleanup());
beforeEach(() => env.clearFirestore());

const as   = uid => env.authenticatedContext(uid).firestore();
const anon = ()  => env.unauthenticatedContext().firestore();
// Seed data the way an admin would, bypassing the rules under test.
const seed = (path, data) => env.withSecurityRulesDisabled(ctx => ctx.firestore().doc(path).set(data));

describe('users/{uid}/**', () => {
  test('a user can create, read, update and delete their own documents', async () => {
    const ref = as('alice').doc('users/alice/homework/hw1');
    await assertSucceeds(ref.set({ description: 'Essay', classId: 'c1' }));
    await assertSucceeds(ref.get());
    await assertSucceeds(ref.update({ completed: true }));
    await assertSucceeds(ref.delete());
  });

  test('every subcollection is covered, not just homework', async () => {
    for (const col of ['tabs', 'classes', 'folders', 'homework']) {
      await assertSucceeds(as('alice').doc(`users/alice/${col}/x`).set({ order: 0 }));
    }
  });

  test('a user cannot read or write another user\'s documents', async () => {
    await seed('users/bob/homework/hw1', { description: 'Bob\'s essay' });
    await assertFails(as('alice').doc('users/bob/homework/hw1').get());
    await assertFails(as('alice').collection('users/bob/homework').get());
    await assertFails(as('alice').doc('users/bob/homework/hw1').update({ completed: true }));
    await assertFails(as('alice').doc('users/bob/homework/hw1').delete());
    await assertFails(as('alice').doc('users/bob/homework/new').set({ description: 'planted' }));
  });

  test('signed-out visitors get nothing', async () => {
    await seed('users/bob/homework/hw1', { description: 'x' });
    await assertFails(anon().doc('users/bob/homework/hw1').get());
    await assertFails(anon().doc('users/bob/homework/new').set({ description: 'x' }));
  });
});

describe('userPrefs/{uid}', () => {
  test('own prefs are readable and writable', async () => {
    await assertSucceeds(as('alice').doc('userPrefs/alice').set({ notifyBefore: 60 }));
    await assertSucceeds(as('alice').doc('userPrefs/alice').get());
  });

  test('someone else\'s prefs are off limits', async () => {
    await seed('userPrefs/bob', { notifyBefore: 60 });
    await assertFails(as('alice').doc('userPrefs/bob').get());
    await assertFails(as('alice').doc('userPrefs/bob').set({ notifyBefore: 0 }));
    await assertFails(anon().doc('userPrefs/bob').get());
  });
});

describe('pushSubscriptions/{subId}', () => {
  const sub = uid => ({ uid, endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' }, notifyBefore: 60 });

  test('a user can create a subscription for themselves', async () => {
    await assertSucceeds(as('alice').doc('pushSubscriptions/s1').set(sub('alice')));
  });

  // The regression from the rules' own comment: a blanket `write` rule read
  // `resource.data` on create, where it is null, and denied everyone.
  test('creating is allowed even though no document exists yet', async () => {
    await assertSucceeds(as('alice').collection('pushSubscriptions').add(sub('alice')));
  });

  test('a user cannot create a subscription in someone else\'s name', async () => {
    await assertFails(as('alice').doc('pushSubscriptions/s1').set(sub('bob')));
  });

  test('a user can read, update and delete their own subscription', async () => {
    await seed('pushSubscriptions/s1', sub('alice'));
    await assertSucceeds(as('alice').doc('pushSubscriptions/s1').get());
    await assertSucceeds(as('alice').doc('pushSubscriptions/s1').update({ notifyBefore: 30 }));
    await assertSucceeds(as('alice').doc('pushSubscriptions/s1').delete());
  });

  test('a subscription can\'t be handed over to another user', async () => {
    await seed('pushSubscriptions/s1', sub('alice'));
    await assertFails(as('alice').doc('pushSubscriptions/s1').update({ uid: 'bob' }));
  });

  test('other users can\'t read, update, delete or hijack it', async () => {
    await seed('pushSubscriptions/s1', sub('alice'));
    await assertFails(as('bob').doc('pushSubscriptions/s1').get());
    await assertFails(as('bob').doc('pushSubscriptions/s1').update({ notifyBefore: 0 }));
    await assertFails(as('bob').doc('pushSubscriptions/s1').update({ uid: 'bob' }));
    await assertFails(as('bob').doc('pushSubscriptions/s1').delete());
  });

  test('signed-out visitors get nothing', async () => {
    await seed('pushSubscriptions/s1', sub('alice'));
    await assertFails(anon().doc('pushSubscriptions/s1').get());
    await assertFails(anon().doc('pushSubscriptions/s2').set(sub('alice')));
  });
});

describe('everything else', () => {
  test('collections the rules don\'t mention are denied', async () => {
    await assertFails(as('alice').doc('somethingElse/x').set({ a: 1 }));
    await assertFails(as('alice').doc('somethingElse/x').get());
  });
});

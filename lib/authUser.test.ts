import assert from 'node:assert/strict';
import test from 'node:test';
import { authGateState, toAppUser } from './authUser';

test('toAppUser', async (t) => {
  await t.test('null in, null out', () => {
    assert.equal(toAppUser(null), null);
    assert.equal(toAppUser(undefined), null);
  });

  await t.test('the name set in Settings wins over the Google first name', () => {
    const user = toAppUser({
      id: 'user_1',
      firstName: 'Khanh',
      primaryEmailAddress: { emailAddress: 'k@example.com' },
      unsafeMetadata: { display_name: '  Chef K  ' },
    });
    assert.deepEqual(user, { id: 'user_1', email: 'k@example.com', displayName: 'Chef K' });
  });

  await t.test('a blank display name falls back to the first name', () => {
    const user = toAppUser({ id: 'user_1', firstName: ' Khanh ', unsafeMetadata: { display_name: '   ' } });
    assert.equal(user?.displayName, 'Khanh');
  });

  await t.test('a non-string display name is ignored', () => {
    const user = toAppUser({ id: 'user_1', firstName: null, unsafeMetadata: { display_name: 42 } });
    assert.equal(user?.displayName, null);
  });

  await t.test('no email and no names gives nulls, not empty strings', () => {
    assert.deepEqual(toAppUser({ id: 'user_1' }), { id: 'user_1', email: null, displayName: null });
  });
});

test('authGateState', async (t) => {
  await t.test('loading until Clerk has loaded', () => {
    assert.equal(authGateState({ isLoaded: false, isSignedIn: undefined, hasUser: false }), 'loading');
  });

  // The session can resolve a beat before the user object. Showing the sign-in
  // screen in that gap flashes it at every signed-in launch.
  await t.test('signed in but no user object yet is still loading', () => {
    assert.equal(authGateState({ isLoaded: true, isSignedIn: true, hasUser: false }), 'loading');
  });

  await t.test('signed in with a user', () => {
    assert.equal(authGateState({ isLoaded: true, isSignedIn: true, hasUser: true }), 'signedIn');
  });

  await t.test('signed out', () => {
    assert.equal(authGateState({ isLoaded: true, isSignedIn: false, hasUser: false }), 'signedOut');
  });
});

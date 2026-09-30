import assert from 'node:assert/strict';
import test from 'node:test';
import { describeClerkError } from './clerkErrors';

test('describeClerkError', async (t) => {
  await t.test('an API response error maps its first error code to a key', () => {
    const error = {
      code: 'api_response_error',
      errors: [{ code: 'form_password_incorrect', message: 'Password is incorrect.' }],
    };
    assert.deepEqual(describeClerkError(error), { key: 'auth.errorPasswordIncorrect' });
  });

  await t.test('a top-level code maps too', () => {
    assert.deepEqual(describeClerkError({ code: 'form_identifier_exists' }), { key: 'auth.errorEmailTaken' });
  });

  await t.test('an unknown code falls back to Clerk\'s long message', () => {
    const error = { errors: [{ code: 'something_new', message: 'Short', longMessage: 'The long one.' }] };
    assert.deepEqual(describeClerkError(error), { text: 'The long one.' });
  });

  await t.test('then to the short message', () => {
    assert.deepEqual(describeClerkError({ errors: [{ code: 'x', message: 'Short' }] }), { text: 'Short' });
  });

  await t.test('a thrown Error uses its message', () => {
    assert.deepEqual(describeClerkError(new Error('boom')), { text: 'boom' });
  });

  await t.test('nothing usable gives the generic key', () => {
    assert.deepEqual(describeClerkError(null), { key: 'auth.errorGeneric' });
    assert.deepEqual(describeClerkError({}), { key: 'auth.errorGeneric' });
  });
});

// Run with `npm test` (node --test — no test framework dependency).
const test = require('node:test');
const assert = require('node:assert/strict');
const { deleteAccountForUid } = require('./account.js');

function fakeAdmin({ remove, deleteUser } = {}) {
  const calls = [];
  return {
    calls,
    database: () => ({
      ref: (path) => ({
        remove: async () => {
          calls.push(['remove', path]);
          if (remove) await remove();
        },
      }),
    }),
    auth: () => ({
      deleteUser: async (uid) => {
        calls.push(['deleteUser', uid]);
        if (deleteUser) await deleteUser(uid);
      },
    }),
  };
}

test('removes the RTDB profile, then deletes the Auth user, in that order', async () => {
  const admin = fakeAdmin();
  await deleteAccountForUid(admin, 'u1');
  assert.deepEqual(admin.calls, [['remove', 'users/u1'], ['deleteUser', 'u1']]);
});

test('propagates an RTDB removal failure and never reaches deleteUser', async () => {
  const admin = fakeAdmin({ remove: async () => { throw new Error('db unavailable'); } });
  await assert.rejects(() => deleteAccountForUid(admin, 'u1'), /db unavailable/);
  assert.deepEqual(admin.calls, [['remove', 'users/u1']]);
});

test('propagates an Auth deleteUser failure', async () => {
  const admin = fakeAdmin({ deleteUser: async () => { throw new Error('auth/user-not-found'); } });
  await assert.rejects(() => deleteAccountForUid(admin, 'u1'), /user-not-found/);
});

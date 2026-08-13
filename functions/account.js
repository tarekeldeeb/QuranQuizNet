// Server-side account deletion, invoked from the `deleteaccount` callable in
// index.js. Runs via the Admin SDK specifically so it isn't subject to the
// client Auth SDK's own deleteUser(), which throws auth/requires-recent-login
// on any session older than a few minutes — a check anonymous/guest accounts
// can never satisfy (no credential to re-present) and that otherwise forced a
// sign-out/sign-in round trip for social accounts too, without the retry ever
// actually landing. The Admin SDK has no such recency requirement.
async function deleteAccountForUid(admin, uid) {
  // RTDB removal first: if it were reversed and deleteUser() ran first, a
  // failure on the RTDB step would leave an orphaned profile with no owning
  // Auth account at all, unrecoverable by any retry.
  await admin.database().ref(`users/${uid}`).remove();
  await admin.auth().deleteUser(uid);
}

module.exports = { deleteAccountForUid };

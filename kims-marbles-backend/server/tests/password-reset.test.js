// "Forgot password" by email, against a REAL SMTP server (smtp-server) running in the test:
// the app talks SMTP to it exactly as it will to the real mail provider.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { SMTPServer } = require('smtp-server');
const { resetDb, db, boot, api, user } = require('./helpers');

let smtp; const inbox = [];
before(async () => {
  smtp = new SMTPServer({
    authOptional: true, disabledCommands: ['STARTTLS'],
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (d) => { raw += d; });
      stream.on('end', () => { inbox.push({ to: session.envelope.rcptTo.map((r) => r.address), from: session.envelope.mailFrom.address, raw }); cb(); });
    },
  });
  await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
  process.env.SMTP_URL = `smtp://127.0.0.1:${smtp.server.address().port}`;
  process.env.MAIL_FROM = "Kim's Marbles <no-reply@vibenbones.online>";
  process.env.APP_URL = 'https://vibenbones.online';
  await boot();
});
beforeEach(async () => { await resetDb(); inbox.length = 0; });
after(async () => { await new Promise((r) => smtp.close(r)); await db.pool.end(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function nextMail(n = 1) {
  for (let i = 0; i < 100 && inbox.length < n; i++) await sleep(50);
  assert.equal(inbox.length, n, 'expected an email');
  return inbox[n - 1];
}
// quoted-printable can wrap long lines with "=\r\n"; undo that before looking for the link
const linkIn = (mail) => mail.raw.replace(/=\r?\n/g, '').match(/https:\/\/vibenbones\.online\/reset\/([\w-]{40,})/)?.[1];
const forgot = (email) => api().post('/api/auth/forgot').send({ email });
const reset = (token, password) => api().post('/api/auth/reset').send({ token, password });
const login = (email, password) => api().post('/api/auth/login').send({ email, password });

test('the whole flow: email arrives with a one-time link; the new password works and the old one does not', async () => {
  const bob = await user('Bob');
  const r = await forgot('BOB@x.com');
  assert.equal(r.status, 202);
  const mail = await nextMail();
  assert.deepEqual(mail.to, ['bob@x.com']);
  assert.equal(mail.from, 'no-reply@vibenbones.online');
  assert.match(mail.raw, /Subject: Reset your Kim's Marbles password/);
  const token = linkIn(mail);
  assert.ok(token, 'the email contains a reset link');
  assert.equal((await reset(token, 'brand new password')).status, 204);
  assert.equal((await login('bob@x.com', 'password123')).status, 401);
  assert.equal((await login('bob@x.com', 'brand new password')).status, 200);
  assert.equal((await reset(token, 'another password')).status, 400, 'a link works once');
  void bob;
});

test('an unknown email gets the same answer and no email (nobody can probe who has an account)', async () => {
  await user('Bob');
  const known = await forgot('bob@x.com');
  const unknown = await forgot('nobody@x.com');
  assert.equal(unknown.status, known.status);
  assert.deepEqual(unknown.body, known.body);
  await nextMail(1);
  await sleep(300);
  assert.equal(inbox.length, 1);
});

test('resetting logs out every existing session', async () => {
  await user('Bob');
  const s = (await login('bob@x.com', 'password123')).body;
  await forgot('bob@x.com');
  await reset(linkIn(await nextMail()), 'brand new password');
  assert.equal((await api().post('/api/auth/refresh').send({ refreshToken: s.refreshToken })).status, 401);
});

test('only the newest link works; links expire; bad input is refused', async () => {
  await user('Bob');
  await forgot('bob@x.com'); const first = linkIn(await nextMail(1));
  await forgot('bob@x.com'); const second = linkIn(await nextMail(2));
  assert.equal((await reset(first, 'brand new password')).status, 400, 'an older link is cancelled by a newer one');
  assert.equal((await reset(second, 'short')).status, 400, 'password rules apply');
  await db.query("update password_resets set expires_at = now() - interval '1 second'");
  assert.equal((await reset(second, 'brand new password')).status, 400, 'expired');
  assert.equal((await reset('x'.repeat(43), 'brand new password')).status, 400);
  assert.equal((await reset(undefined, 'brand new password')).status, 400);
  assert.equal((await forgot('not an email')).status, 400);
});

test('only the hash of the token is stored', async () => {
  await user('Bob');
  await forgot('bob@x.com');
  const token = linkIn(await nextMail());
  const rows = (await db.query('select token_hash from password_resets')).rows;
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token);
  assert.ok(!JSON.stringify(rows).includes(token));
});

test('a suspended account gets no reset email', async () => {
  const admin = await user('Admin', { admin: true }); const bob = await user('Bob');
  await api().post(`/api/users/${bob.id}/ban`).set({ Authorization: `Bearer ${admin.token}` }).send({});
  assert.equal((await forgot('bob@x.com')).status, 202);
  await sleep(400);
  assert.equal(inbox.length, 0);
});

test('without an email account configured, the app says so instead of pretending to send', async () => {
  const saved = process.env.SMTP_URL;
  delete process.env.SMTP_URL;
  try {
    await user('Bob');
    const r = await forgot('bob@x.com');
    assert.equal(r.status, 503);
    assert.match(r.body.error, /not set up/);
    const status = await api().get('/api/auth/reset-available');
    assert.deepEqual(status.body, { available: false });
  } finally { process.env.SMTP_URL = saved; }
  assert.deepEqual((await api().get('/api/auth/reset-available')).body, { available: true });
});

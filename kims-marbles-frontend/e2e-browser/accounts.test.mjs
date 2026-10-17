// Suspension and "forgot password" in real browsers against the real backend. The reset email
// goes over real SMTP to a mail server this test runs on 127.0.0.1:2525; start the backend
// with SMTP_URL=smtp://127.0.0.1:2525 for the reset test (it is skipped otherwise).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { APP, API, T, startBrowser, stopBrowser, until, newUser, openPage, openAnon, cleanup } from './helpers.mjs';

const require = createRequire(new URL('../../kims-marbles-backend/server/package.json', import.meta.url));
const SMTP_PORT = Number(process.env.E2E_SMTP_PORT || 2525);
const DB = process.env.E2E_DATABASE_URL || 'postgres://postgres@127.0.0.1:5433/km_e2e_test';
const inbox = [];
let smtp = null;

before(async () => {
  await startBrowser();
  if (process.env.E2E_SMTP) {
    const { SMTPServer } = require('smtp-server');
    smtp = new SMTPServer({
      authOptional: true, disabledCommands: ['STARTTLS'],
      onData(stream, session, cb) { let raw = ''; stream.on('data', (d) => { raw += d; }); stream.on('end', () => { inbox.push({ to: session.envelope.rcptTo.map((r) => r.address), raw }); cb(); }); },
    });
    await new Promise((r) => smtp.listen(SMTP_PORT, '127.0.0.1', r));
  }
});
after(async () => { await stopBrowser(); if (smtp) await new Promise((r) => smtp.close(r)); });

function makeAdmin(u) {
  execFileSync('psql', [DB, '-q', '-c', `update users set is_admin = true where id = '${u.user.id}'`]);
  u.user = { ...u.user, is_admin: true };
}

test('a moderator suspends someone from a report: their open page signs them out and says why; they cannot log back in', T, async () => {
  try {
    const bob = await newUser('bob'); const ann = await newUser('ann'); const mod = await newUser('mod');
    makeAdmin(mod);
    const b = await openPage(bob); await b.goto(`${APP}/feed`);
    await b.getByPlaceholder(/Share a haul/).fill('DM me for fake Lutz marbles cheap');
    await b.getByRole('button', { name: 'Post', exact: true }).click();
    await b.locator('article', { hasText: 'fake Lutz' }).waitFor();

    const a = await openPage(ann); await a.goto(`${APP}/feed`);
    await a.locator('article', { hasText: 'fake Lutz' }).getByRole('button', { name: '⚑ Report' }).click();
    await a.getByLabel(/What's wrong/).selectOption('Scam or fraud');
    await a.getByRole('button', { name: 'Send report' }).click();
    await a.getByText('A moderator will review it').waitFor();

    const m = await openPage(mod); await m.goto(`${APP}/moderation`);
    const row = m.locator('.report-row', { hasText: 'fake Lutz' });
    await row.waitFor();
    m.once('dialog', (d) => d.accept('selling counterfeits'));
    await row.getByRole('button', { name: 'Suspend the author' }).click();
    await m.getByText(`${bob.handle} is suspended`).waitFor();
    await m.getByRole('button', { name: 'Suspended' }).click();
    await m.locator('.banned-row', { hasText: bob.handle }).waitFor();
    assert.match(await m.locator('.banned-row', { hasText: bob.handle }).innerText(), /selling counterfeits/);

    // Bob's open tab: the next thing he does signs him out with the reason
    await b.goto(`${APP}/dashboard`);
    await b.getByText(/This account has been suspended/).waitFor({ timeout: 10_000 });
    await b.getByLabel('Email').fill(bob.email);
    await b.getByLabel('Password').fill(bob.password);
    await b.getByRole('button', { name: 'Log In' }).click();
    await b.getByText('This account has been suspended').waitFor();

    // unsuspend: he can log in again
    m.once('dialog', (d) => d.accept());
    await m.locator('.banned-row', { hasText: bob.handle }).getByRole('button', { name: 'Unsuspend' }).click();
    await until(async () => (await m.locator('.banned-row', { hasText: bob.handle }).count()) === 0, { what: 'the row to go' });
    await b.getByRole('button', { name: 'Log In' }).click();
    await b.locator('.top-header').waitFor({ timeout: 10_000 });
  } finally { await cleanup(); }
});

test('forgot password: the email arrives over SMTP, the link sets a new password, the old one stops working', { ...T, skip: !process.env.E2E_SMTP }, async () => {
  try {
    const kim = await newUser('kim');
    const page = await openAnon(); await page.goto(APP);
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    await page.getByLabel('Email').fill(kim.email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await page.getByText(/a reset link is on its way/).waitFor();
    await until(() => inbox.some((m) => m.to.includes(kim.email)), { what: 'the reset email' });
    const mail = inbox.find((m) => m.to.includes(kim.email));
    const link = mail.raw.replace(/=\r?\n/g, '').match(/https?:\/\/[^\s"<>]+\/reset\/[\w-]{40,}/)[0];
    assert.ok(link.startsWith(APP), `the link points at the app: ${link}`);

    await page.goto(link);
    await page.getByLabel('New password', { exact: true }).fill('a fresh password 42');
    await page.getByLabel('New password again').fill('a fresh password 42');
    await page.getByRole('button', { name: 'Save new password' }).click();
    await page.getByText('Password changed').waitFor();

    const old = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: kim.email, password: kim.password }) });
    assert.equal(old.status, 401);
    await page.getByRole('button', { name: 'Log In' }).click();
    await page.getByLabel('Email').fill(kim.email);
    await page.getByLabel('Password').fill('a fresh password 42');
    await page.getByRole('button', { name: 'Log In' }).click();
    await page.locator('.top-header').waitFor({ timeout: 10_000 });

    await page.goto(link);   // the link works once
    await page.getByLabel('New password', { exact: true }).fill('another one 12345');
    await page.getByLabel('New password again').fill('another one 12345');
    await page.getByRole('button', { name: 'Save new password' }).click();
    await page.getByText(/not valid or has expired/).waitFor();
  } finally { await cleanup(); }
});

// Dashboard, saved listing templates, and the two games — through the real UI, real server,
// real browser. The numbers on the dashboard must come from what the person actually did.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { API, APP, T, startBrowser, stopBrowser, sleep, until, newUser, openPage, cleanup } from './helpers.mjs';
import { QUIZ } from '../src/lib/learnData.js';

before(startBrowser);
after(stopBrowser);

const api = async (path, user, opts = {}) =>
  (await fetch(`${API}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.accessToken}` } })).json();

test('real actions appear on the dashboard, and a saved template can be reused and deleted', T, async () => {
  try {
    const u = await newUser('dash');
    const page = await openPage(u);
    const name = `Browser Swirl ${u.handle}`;

    await page.goto(`${APP}/market`);                                           // 1. list a marble, saving it as a template first
    await page.getByRole('button', { name: '＋ List a Marble' }).click();
    await page.getByPlaceholder('Name').fill(name);
    await page.getByPlaceholder('Price ($)').fill('42');
    await page.getByPlaceholder('Description').fill('made in the browser test');
    await page.getByRole('button', { name: '💾 Save as Template' }).click();
    await page.getByText(`Template "${name}" saved`).waitFor();
    await page.getByRole('button', { name: 'Publish Listing' }).click();
    await page.getByText(name, { exact: true }).first().waitFor({ timeout: 10_000 });

    await page.goto(`${APP}/feed`);                                              // 2. enter the weekly challenge
    await page.getByPlaceholder(/Share a haul/).fill('#SwirlChallenge my entry from the browser');
    await page.getByRole('button', { name: 'Post', exact: true }).click();
    await page.locator('article', { hasText: 'my entry from the browser' }).waitFor();   // the post itself, not the textarea

    await page.goto(`${APP}/dashboard`);                                         // 3. the dashboard reflects both
    await page.getByText('At a glance').waitFor();
    assert.match(await page.locator('.stat-card', { hasText: 'Active listings' }).innerText(), /1/);
    await page.getByText('1 entry so far.').waitFor();
    await page.getByText(`Listed "${name}" on the marketplace`).waitFor();
    await page.getByText('Posted to the community feed').waitFor();
    await page.getByText('2 of 8 unlocked').waitFor();
    assert.match(await page.locator('.badge-card', { hasText: 'First Listing' }).getAttribute('class'), /unlocked/);
    assert.match(await page.locator('.badge-card', { hasText: 'Community Voice' }).getAttribute('class'), /unlocked/);
    const row = page.locator('.template-row', { hasText: name });
    await row.waitFor();

    await row.getByRole('button', { name: 'Use' }).click();                      // 4. "Use" opens the listing form already filled in
    await page.getByPlaceholder('Name').waitFor();
    assert.equal(await page.getByPlaceholder('Name').inputValue(), name);
    assert.equal(await page.getByPlaceholder('Price ($)').inputValue(), '42');
    assert.equal(await page.getByPlaceholder('Description').inputValue(), 'made in the browser test');
    assert.ok(!page.url().includes('template='), 'the template param should be consumed so a refresh does not reopen the form');

    await page.goto(`${APP}/dashboard`);                                         // 5. delete it; the server agrees
    await page.locator('.template-row', { hasText: name }).getByRole('button', { name: 'Delete' }).click();
    await until(async () => (await page.locator('.template-row', { hasText: name }).count()) === 0, { what: 'the row to disappear' });
    assert.deepEqual(await api('/api/templates', u), []);
  } finally { await cleanup(); }
});

test('Speed ID in a real browser: the run ends, and the score is really saved on the server', T, async () => {
  try {
    const u = await newUser('speed');
    const page = await openPage(u);
    await page.goto(`${APP}/learn`);
    const game = page.getByTestId('speed-game');
    await game.getByRole('button', { name: '▶ Start' }).click();
    // answer the first option every round: a wrong pick ends the run quickly
    for (let i = 0; i < 60 && !(await game.getByRole('button', { name: '↻ Play Again' }).count()); i++) {
      const opt = game.locator('.quiz-opt:not([disabled])').first();
      if (await opt.count()) await opt.click().catch(() => {});
      await sleep(650);
    }
    await game.getByRole('button', { name: '↻ Play Again' }).waitFor({ timeout: 5_000 });
    const shown = Number(await game.locator('.score').innerText());
    await until(async () => (await api('/api/dashboard', u)).games.speed.plays === 1, { what: 'the score to reach the server' });
    const saved = (await api('/api/dashboard', u)).games.speed;
    assert.equal(saved.best, shown, 'the best on the server should equal the score shown');
  } finally { await cleanup(); }
});

test('trivia in a real browser: a perfect run is saved and the SERVER awards Quiz Whiz', T, async () => {
  try {
    const u = await newUser('quiz');
    const page = await openPage(u);
    await page.goto(`${APP}/learn`);
    const quiz = page.locator('.quiz-card', { hasText: 'Question 1 of 7' });
    for (let i = 0; i < QUIZ.length; i++) {
      await page.getByText(`Question ${i + 1} of ${QUIZ.length}`).waitFor();
      await page.getByRole('button', { name: QUIZ[i].opts[QUIZ[i].a], exact: true }).click();
      await sleep(1000);
    }
    await page.getByText('Perfect score — true collector!').waitFor({ timeout: 8_000 });
    await page.getByText(/Quiz Whiz earned/).waitFor();
    await until(async () => (await api('/api/achievements', u)).find((a) => a.key === 'quizWhiz').unlocked, { what: 'the server to award Quiz Whiz' });
    assert.deepEqual((await api('/api/dashboard', u)).games.trivia, { best: 7, plays: 1 });
    void quiz;
  } finally { await cleanup(); }
});

test('no page scrolls sideways on a phone', T, async () => {
  try {
    const u = await newUser('phone');
    const page = await openPage(u, { colorScheme: 'light' });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const route of ['/market', '/panels', '/battles', '/feed', '/collection', '/dashboard', '/learn', '/messages', '/me']) {
      await page.goto(`${APP}${route}`);
      await page.locator('.top-header').waitFor();
      await sleep(600);                                                          // let the page's data arrive
      const r = await page.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, vw: window.innerWidth }));
      assert.ok(r.scrollW <= r.vw + 1, `${route} scrolls sideways on a phone (content ${r.scrollW}px in a ${r.vw}px window)`);
    }
  } finally { await cleanup(); }
});

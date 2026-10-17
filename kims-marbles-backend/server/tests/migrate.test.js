// The migration runner against real throwaway databases: a fresh install, re-runs, new
// migrations, a failing migration, and adopting a database created before migrations existed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');

const BASE = new URL(process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5433/km_test');
const urlFor = (name) => Object.assign(new URL(BASE), { pathname: `/${name}` }).toString();
const MIG = path.join(__dirname, '..', 'scripts', 'migrate.js');
const DBS = ['km_migrate_a_test', 'km_migrate_b_test'];

async function admin(sql) {
  const c = new Client({ connectionString: urlFor('postgres') });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}
async function q(name, sql) {
  const c = new Client({ connectionString: urlFor(name) });
  await c.connect();
  try { return (await c.query(sql)).rows; } finally { await c.end(); }
}
function migrate(name, env = {}) {
  return spawnSync(process.execPath, [MIG], { env: { PATH: process.env.PATH, DATABASE_URL: urlFor(name), ...env }, encoding: 'utf8', timeout: 60_000 });
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'km-mig-'));

before(async () => { for (const d of DBS) { await admin(`drop database if exists ${d} with (force)`); await admin(`create database ${d}`); } });
after(async () => { for (const d of DBS) await admin(`drop database if exists ${d} with (force)`); });

test('a fresh database gets the whole schema (with RLS) and a record of it; running again changes nothing', async () => {
  const r = migrate(DBS[0]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /applied 0001_initial/);
  const tables = (await q(DBS[0], "select count(*)::int as n from pg_tables where schemaname = 'public' and rowsecurity")).at(0).n;
  assert.ok(tables >= 30, `expected RLS on 30+ tables, got ${tables}`);
  // every real migration also applies cleanly on top of a fresh schema
  const shipped = fs.readdirSync(path.join(__dirname, '..', '..', 'migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).map((f) => f.replace(/\.sql$/, '')).sort();
  assert.deepEqual((await q(DBS[0], 'select version from schema_migrations order by version')).map((x) => x.version), ['0001_initial', ...shipped]);
  const again = migrate(DBS[0]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /up to date/);
});

test('new migrations apply once, in order', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '0003_b.sql'), 'alter table mig_probe add column b int;');
  fs.writeFileSync(path.join(dir, '0002_a.sql'), 'create table mig_probe (a int);');
  const r = migrate(DBS[0], { MIGRATIONS_DIR: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /applied 0002_a[\s\S]*applied 0003_b/);
  assert.equal(migrate(DBS[0], { MIGRATIONS_DIR: dir }).status, 0);
  const cols = (await q(DBS[0], "select column_name from information_schema.columns where table_name = 'mig_probe' order by column_name")).map((c) => c.column_name);
  assert.deepEqual(cols, ['a', 'b']);
});

test('a failing migration is rolled back completely, is not recorded, and stops the run with an error', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '0002_a.sql'), 'create table mig_probe (a int);');
  fs.writeFileSync(path.join(dir, '0003_b.sql'), 'alter table mig_probe add column b int;');
  fs.writeFileSync(path.join(dir, '0004_bad.sql'), 'create table half_done (x int); select * from no_such_table;');
  fs.writeFileSync(path.join(dir, '0005_after.sql'), 'create table never_reached (x int);');
  const r = migrate(DBS[0], { MIGRATIONS_DIR: dir });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /0004_bad/);
  assert.deepEqual(await q(DBS[0], "select 1 from pg_tables where tablename in ('half_done', 'never_reached')"), []);
  assert.deepEqual(await q(DBS[0], "select 1 from schema_migrations where version in ('0004_bad', '0005_after')"), []);
});

test('a database created before migrations existed is adopted, not re-created', async () => {
  const root = path.join(__dirname, '..', '..');
  for (const f of ['dev/local-auth-stub.sql', 'schema.sql', 'rls.sql']) {
    const c = new Client({ connectionString: urlFor(DBS[1]) });
    await c.connect(); await c.query(fs.readFileSync(path.join(root, f), 'utf8')); await c.end();
  }
  await q(DBS[1], "insert into users (handle, email, password_hash) values ('Kept', 'kept@x.com', 'x')");
  const r = migrate(DBS[1]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /existing database: recorded 0001_initial/);
  assert.equal((await q(DBS[1], "select count(*)::int as n from users where handle = 'Kept'"))[0].n, 1, 'data kept');
});

test('SeeWhy LIVE\'s database is refused before connecting', () => {
  const r = spawnSync(process.execPath, [MIG], { env: { PATH: process.env.PATH, DATABASE_URL: 'postgres://u:p@db.xlrcibziouffgxciecvc.supabase.co:5432/postgres' }, encoding: 'utf8', timeout: 20_000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /SeeWhy/);
});

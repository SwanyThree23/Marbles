// Database migrations. Run on every deploy (it is safe to run any number of times):
//   DATABASE_URL=postgres://... node scripts/migrate.js        (npm run migrate)
//
// 0001_initial is schema.sql + rls.sql. On plain Postgres (not Supabase) it first installs
// dev/local-auth-stub.sql, which provides the auth.uid() the RLS policies use. A database
// that already has the tables (created before this runner existed) is recorded, not rebuilt.
// Later changes go in ../migrations/NNNN_name.sql and run once each, in order, each in its own
// transaction: a failing one is rolled back completely and stops the run.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const DIR = process.env.MIGRATIONS_DIR || path.join(ROOT, 'migrations');
const url = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
const LOCK = 727274; // pg_advisory_lock key: two deploys at once take turns

function fail(msg) { console.error(`[migrate] ${msg}`); process.exit(1); }
if (!url) fail('DATABASE_URL is not set');
if (url.includes('xlrcibziouffgxciecvc')) fail("refusing: that is SeeWhy LIVE's database, not Kim's Marbles'");

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

(async () => {
  const db = new Client({ connectionString: url, ssl: /supabase\.(co|com)/.test(url) ? { rejectUnauthorized: false } : undefined });
  await db.connect();
  try {
    await db.query('select pg_advisory_lock($1)', [LOCK]);
    await db.query('create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await db.query('select version from schema_migrations')).rows.map((r) => r.version));
    let changed = 0;

    async function apply(version, sql) {
      try {
        await db.query('begin');
        await db.query(sql);
        await db.query('insert into schema_migrations (version) values ($1)', [version]);
        await db.query('commit');
        console.log(`[migrate] applied ${version}`);
        changed += 1;
      } catch (err) {
        await db.query('rollback').catch(() => {});
        throw new Error(`${version} failed and was rolled back: ${err.message}`);
      }
    }

    if (!done.has('0001_initial')) {
      const exists = (await db.query("select to_regclass('public.users') is not null as t")).rows[0].t;
      if (exists) {
        await db.query("insert into schema_migrations (version) values ('0001_initial')");
        console.log('[migrate] existing database: recorded 0001_initial without changing anything');
        changed += 1;
      } else {
        const hasAuth = (await db.query("select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'auth' and p.proname = 'uid') as t")).rows[0].t;
        await apply('0001_initial', `${hasAuth ? '' : read('dev/local-auth-stub.sql')}\n${read('schema.sql')}\n${read('rls.sql')}`);
      }
    }

    const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => /^\d{4}_[\w-]+\.sql$/.test(f)).sort() : [];
    for (const f of files) {
      const version = f.replace(/\.sql$/, '');
      if (version === '0001_initial' || done.has(version)) continue;
      await apply(version, fs.readFileSync(path.join(DIR, f), 'utf8'));
    }
    if (!changed) console.log('[migrate] up to date');
  } finally {
    await db.end().catch(() => {});
  }
})().catch((err) => fail(err.message));

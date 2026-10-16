// Recreates the test database from scratch: drop, create, then dev/local-auth-stub.sql,
// schema.sql and rls.sql. Refuses anything that doesn't look like a throwaway database.
//   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/km_test npm run test:db
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const url = new URL(process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5433/km_test');
const name = url.pathname.slice(1);
if (!/(^|_)test($|_)/.test(name)) {
  console.error(`Refusing to recreate "${name}": the test database name must contain "test".`);
  process.exit(1);
}
const ROOT = path.join(__dirname, '..', '..');

(async () => {
  const admin = new Client({ connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).toString() });
  await admin.connect();
  await admin.query(`drop database if exists "${name}" with (force)`);
  await admin.query(`create database "${name}"`);
  await admin.end();

  const db = new Client({ connectionString: url.toString() });
  await db.connect();
  for (const file of ['dev/local-auth-stub.sql', 'schema.sql', 'rls.sql']) {
    await db.query(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  }
  await db.end();
  console.log(`fresh test database "${name}" ready`);
})().catch((err) => { console.error(err.message); process.exit(1); });

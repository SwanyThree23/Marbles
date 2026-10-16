// Shared by every database-backed test file. Points the app at TEST_DATABASE_URL and wipes
// all data between tests (the achievements catalogue is reference data and is kept).
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5433/km_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-not-for-production-0123456789';

const db = require('../db');

let tables = null;
async function resetDb() {
  if (!tables) {
    const r = await db.query(
      "select tablename from pg_tables where schemaname = 'public' and tablename <> 'achievements'"
    ).catch((err) => {
      throw new Error(`Cannot reach the test database (${err.message}). Run: npm run test:db`);
    });
    if (!r.rows.length) throw new Error('The test database has no tables. Run: npm run test:db');
    tables = r.rows.map((t) => `"${t.tablename}"`).join(', ');
  }
  await db.query(`truncate ${tables} restart identity cascade`);
}

module.exports = { resetDb, db };

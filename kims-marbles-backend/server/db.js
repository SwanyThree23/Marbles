// One shared connection pool. DATABASE_URL (or SUPABASE_DB_URL: use Supabase's Session
// pooler string, port 5432). PG_POOL_MAX caps connections per server process.
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
const pool = new Pool({
  connectionString,
  max: parseInt(process.env.PG_POOL_MAX || '10', 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: /supabase\.(co|com)/.test(connectionString || '') ? { rejectUnauthorized: false } : undefined,
});
pool.on('error', (err) => console.error('[db] idle client error', err.message));

const query = (text, params) => pool.query(text, params);

// Runs fn(client) inside BEGIN/COMMIT; rolls back on any error and rethrows it.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, tx };

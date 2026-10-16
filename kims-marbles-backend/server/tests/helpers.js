// Shared helpers for route tests: a booted app, users with tokens, auth headers.
const { resetDb, db } = require('./setup');

let request; let app;
async function boot() {
  request = (await import('supertest')).default;
  app = require('../app');
}
const api = () => request(app);
async function user(handle, { admin = false } = {}) {
  const r = await api().post('/api/auth/register').send({ handle, email: `${handle.toLowerCase()}@x.com`, password: 'password123' });
  if (r.status !== 201) throw new Error(`could not register ${handle}: ${r.status} ${JSON.stringify(r.body)}`);
  if (admin) await db.query('update users set is_admin = true where id = $1', [r.body.user.id]);
  return { token: r.body.accessToken, id: r.body.user.id, handle };
}
const as = (u) => ({ Authorization: `Bearer ${u.token}` });
const NIL = '00000000-0000-0000-0000-000000000000';
const notes = async (u) => (await db.query('select * from notifications where user_id = $1 order by created_at', [u.id])).rows;

module.exports = { resetDb, db, boot, api, user, as, NIL, notes };

// Boot-time configuration checks. checkConfig(env) never throws and never echoes a secret:
// it returns { errors, warnings }, and index.js refuses to start while there are errors.
// Production (NODE_ENV=production) is strict; anything else only needs a JWT secret.

// Kim's Marbles is a separate product from SeeWhy LIVE and must never touch its systems.
const SEEWHY_SUPABASE_REF = 'xlrcibziouffgxciecvc';
const SEEWHY_VPS_IP = '2.24.194.112';

const PLACEHOLDER_RE = /change[_-]?me|your[_-]|example|placeholder/i;
const int = (v) => (/^\d+$/.test(String(v)) ? Number(v) : NaN);

function isPublicIPv4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip || '');
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((x) => Number(x) > 255)) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}

function checkConfig(env) {
  const errors = [];
  const warnings = [];
  const prod = env.NODE_ENV === 'production';
  const dbUrl = env.DATABASE_URL || env.SUPABASE_DB_URL || '';

  // ---- always ----
  if (dbUrl.includes(SEEWHY_SUPABASE_REF)) errors.push("DATABASE_URL points at SeeWhy LIVE's Supabase project. Kim's Marbles must use its own database.");
  if (env.MEDIASOUP_ANNOUNCED_IP === SEEWHY_VPS_IP) errors.push("MEDIASOUP_ANNOUNCED_IP is SeeWhy LIVE's VPS. Kim's Marbles runs on its own server.");
  if (!env.JWT_SECRET) errors.push('JWT_SECRET is required (make one with: openssl rand -hex 32).');
  const stripeKey = env.STRIPE_SECRET_KEY || '';
  if (/^(sk|rk)_live_/.test(stripeKey) && env.STRIPE_ALLOW_LIVE !== 'true') {
    errors.push('A live Stripe key is configured. Use a test key (sk_test_...) until live payments are approved.');
  }
  if (env.REDIS_URL) {
    errors.push('REDIS_URL is set, but Kim\'s Marbles supports one server process only (live rooms, media and rate limits live in its memory). Remove REDIS_URL and run a single process.');
  }
  for (const [name, lo, hi] of [['PORT', 1, 65535], ['MEDIASOUP_PORT', 1024, 65535], ['MEDIASOUP_WORKERS', 1, 64], ['PG_POOL_MAX', 1, 200]]) {
    if (env[name] !== undefined && !(int(env[name]) >= lo && int(env[name]) <= hi)) errors.push(`${name} must be a whole number from ${lo} to ${hi}.`);
  }
  if (env.TURN_URLS && !env.TURN_SECRET) errors.push('TURN_URLS is set but TURN_SECRET is not: nobody would get TURN credentials.');

  if (!prod) return { errors, warnings };

  // ---- production ----
  if (!dbUrl) errors.push('DATABASE_URL is required (postgres://user:password@host:5432/dbname).');
  if (env.JWT_SECRET && (env.JWT_SECRET.length < 32 || PLACEHOLDER_RE.test(env.JWT_SECRET))) {
    errors.push('JWT_SECRET must be a random value of at least 32 characters (openssl rand -hex 32), not a placeholder.');
  }
  if (!env.APP_URL) errors.push('APP_URL is required (the public site address, e.g. https://vibenbones.online).');
  else if (!/^https:\/\/[^\s/]+$/.test(env.APP_URL.replace(/\/$/, ''))) errors.push('APP_URL must be the https:// address of the site, with no path.');
  if (!env.MEDIASOUP_ANNOUNCED_IP) errors.push("MEDIASOUP_ANNOUNCED_IP is required: the server's public IPv4. Without it nobody receives video.");
  else if (env.MEDIASOUP_ANNOUNCED_IP !== SEEWHY_VPS_IP && !isPublicIPv4(env.MEDIASOUP_ANNOUNCED_IP)) {
    errors.push("MEDIASOUP_ANNOUNCED_IP must be the server's PUBLIC IPv4 address (not a private, loopback or hostname value).");
  }
  if (env.TURN_SECRET && env.TURN_SECRET.length < 32) errors.push('TURN_SECRET must be at least 32 characters (openssl rand -hex 32).');
  if (env.CORS_ORIGINS) {
    const bad = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter((o) => o && !/^https:\/\/[^\s/]+$/.test(o));
    if (bad.length) errors.push('CORS_ORIGINS must be a comma-separated list of https:// origins with no paths.');
  }
  if (env.HOST_GRACE_MS !== undefined && !(int(env.HOST_GRACE_MS) >= 1000)) errors.push('HOST_GRACE_MS must be at least 1000 (milliseconds).');

  if (!stripeKey) warnings.push('STRIPE_SECRET_KEY is not set: payments are off (tips and checkout answer 503).');
  else if (!env.STRIPE_WEBHOOK_SECRET) warnings.push('STRIPE_WEBHOOK_SECRET is not set: paid orders and tips will never be marked paid.');
  if (!env.TURN_URLS) warnings.push('No TURN relay configured (TURN_URLS): viewers on strict networks will not get video.');
  if (!env.METRICS_TOKEN) warnings.push('METRICS_TOKEN is not set: /metrics is disabled.');
  return { errors, warnings };
}

module.exports = { checkConfig, isPublicIPv4 };

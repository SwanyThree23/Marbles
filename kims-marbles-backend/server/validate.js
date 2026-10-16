// Input validators shared by REST routes and socket handlers. Anything a client sends is
// untrusted: a bad value is a 400 (or a refused socket event), never a database error.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
// a whole number (a JS number, not a numeric string) within [min, max]
const isInt = (v, min = -Infinity, max = Infinity) => Number.isInteger(v) && v >= min && v <= max;
// a string whose length is within [min, max]
const isStr = (v, min = 0, max = Infinity) => typeof v === 'string' && v.length >= min && v.length <= max;

const LISTING_TYPES = ['sale', 'trade', 'auction'];
const LISTING_GRADES = ['mint', 'near-mint', 'good'];
const MAX_PRICE_CENTS = 100_000_000; // $1,000,000

module.exports = { isUuid, isInt, isStr, LISTING_TYPES, LISTING_GRADES, MAX_PRICE_CENTS };

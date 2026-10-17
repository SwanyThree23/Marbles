// Outgoing email (password resets). SMTP_URL is the mail provider's SMTP address, e.g.
//   smtps://no-reply%40vibenbones.online:PASSWORD@smtp.hostinger.com:465
// (an @ in the user name is written %40). Without SMTP_URL, email is off and callers say so.
const nodemailer = require('nodemailer');

let cached = { url: null, transport: null };
function transport() {
  const url = process.env.SMTP_URL;
  if (!url) return null;
  if (cached.url !== url) cached = { url, transport: nodemailer.createTransport(url) };
  return cached.transport;
}
const available = () => !!process.env.SMTP_URL;

async function send({ to, subject, text, html }) {
  const t = transport();
  if (!t) throw new Error('email is not configured (SMTP_URL)');
  return t.sendMail({ from: process.env.MAIL_FROM || "Kim's Marbles <no-reply@vibenbones.online>", to, subject, text, html });
}

module.exports = { send, available };

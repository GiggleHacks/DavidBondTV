// Minimal email sender. Uses Gmail SMTP over implicit TLS (port 465, AUTH LOGIN)
// when GMAIL_USER + GMAIL_APP_PASSWORD are set. Otherwise falls back to a "dev
// outbox": the message is written to data/outbox/ and the key link is logged, so
// signup/reset flows are fully testable without configuring email.
//
// No external dependency — raw SMTP over node:tls. Isolated here so it can be
// swapped for a transactional provider later without touching routes.
import tls from 'node:tls';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTBOX = path.join(__dirname, '..', 'data', 'outbox');

const SMTP_HOST = 'smtp.gmail.com';
const SMTP_PORT = 465;

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export function resendConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

export function gmailConfigured() {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

export function mailerConfigured() {
  return resendConfigured() || gmailConfigured();
}

/**
 * Local development mode: when BASE_URL points at localhost (or is unset), the
 * links we'd email are useless to a real recipient and Gmail flags them as spam.
 * So we always use the dev outbox locally — links are written to data/outbox/ +
 * console instead of being sent. Real SMTP only engages for a real-domain BASE_URL.
 */
function isLocalBaseUrl() {
  const base = process.env.BASE_URL;
  if (!base) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(base);
}

function mailFrom() {
  return process.env.MAIL_FROM || process.env.GMAIL_USER || 'no-reply@davidbond.tv';
}

/**
 * True when mail isn't actually delivered to an inbox — either BASE_URL is local
 * or no SMTP credentials are set, so messages go to the dev outbox. Routes use
 * this to surface verification links directly in the UI for local testing.
 */
export function mailDevMode() {
  return isLocalBaseUrl() || !mailerConfigured();
}

/** Read one full SMTP reply (handles multi-line "250-" continuations). */
function readReply(socket) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      // A complete reply ends with a line "<code> ..." (space after the code).
      const lines = buf.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1];
      if (last && /^\d{3} /.test(last)) {
        cleanup();
        resolve({ code: Number(last.slice(0, 3)), text: buf });
      }
    };
    const onErr = (e) => { cleanup(); reject(e); };
    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onErr);
    };
    socket.on('data', onData);
    socket.on('error', onErr);
  });
}

async function cmd(socket, line, expect) {
  if (line !== null) socket.write(`${line}\r\n`);
  const reply = await readReply(socket);
  if (expect && !expect.includes(reply.code)) {
    throw new Error(`SMTP unexpected ${reply.code}: ${reply.text.trim()}`);
  }
  return reply;
}

function buildMessage({ to, subject, html, text }) {
  const boundary = `bnd_${crypto.randomBytes(12).toString('hex')}`;
  const headers = [
    `From: ${mailFrom()}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@davidbond.tv>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join('\r\n');
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    text || '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    html || '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return `${headers}\r\n\r\n${body}`;
}

/**
 * Send via the Resend HTTP API (https://resend.com). Preferred transport in
 * production: better deliverability than raw Gmail SMTP, no daily 500 cap, and
 * proper SPF/DKIM once the sending domain is verified in the Resend dashboard.
 * Uses the global fetch (Node 18+) — no dependency. Throws on non-2xx so the
 * caller can fall back to the dev outbox.
 */
async function sendViaResend({ to, subject, html, text }) {
  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: mailFrom(), to: [to], subject, html, text }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 200)}`);
  }
}

async function sendViaSmtp({ to, subject, html, text }) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  const socket = tls.connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST });
  await new Promise((res, rej) => {
    socket.once('secureConnect', res);
    socket.once('error', rej);
  });
  try {
    await cmd(socket, null, [220]);
    await cmd(socket, 'EHLO davidbond.tv', [250]);
    await cmd(socket, 'AUTH LOGIN', [334]);
    await cmd(socket, Buffer.from(user).toString('base64'), [334]);
    await cmd(socket, Buffer.from(pass).toString('base64'), [235]);
    await cmd(socket, `MAIL FROM:<${process.env.GMAIL_USER}>`, [250]);
    await cmd(socket, `RCPT TO:<${to}>`, [250]);
    await cmd(socket, 'DATA', [354]);
    const msg = buildMessage({ to, subject, html, text }).replace(/\r\n\./g, '\r\n..');
    socket.write(`${msg}\r\n.\r\n`);
    await cmd(socket, null, [250]);
    await cmd(socket, 'QUIT', [221]).catch(() => {});
  } finally {
    socket.end();
  }
}

async function writeToOutbox({ to, subject, html, text }) {
  await fsp.mkdir(OUTBOX, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeTo = String(to).replace(/[^a-z0-9@._-]/gi, '_');
  const file = path.join(OUTBOX, `${stamp}_${safeTo}.txt`);
  const content = `To: ${to}\nSubject: ${subject}\n\n${text || ''}\n\n--- HTML ---\n${html || ''}\n`;
  await fsp.writeFile(file, content, 'utf8');
  // Surface the actionable link(s) on the console for easy dev testing.
  const link = (text || html || '').match(/https?:\/\/\S+/);
  console.log(`✉  [dev outbox] ${subject} → ${to}`);
  if (link) console.log(`   ${link[0]}`);
  console.log(`   saved: ${file}`);
  return { ok: true, dev: true, file };
}

/**
 * Send an email. Returns { ok, dev? } and never throws upward.
 * Transport priority: Resend (if RESEND_API_KEY) → Gmail SMTP (if creds) →
 * dev outbox. Each real transport falls through to the outbox on failure so a
 * provider outage never breaks signup/reset flows.
 */
export async function sendMail({ to, subject, html, text }) {
  // Local dev (localhost BASE_URL) or no transport configured → write to outbox.
  if (isLocalBaseUrl() || !mailerConfigured()) {
    return writeToOutbox({ to, subject, html, text });
  }
  if (resendConfigured()) {
    try {
      await sendViaResend({ to, subject, html, text });
      return { ok: true };
    } catch (err) {
      console.error(`✉  Resend send failed: ${err.message} — trying next transport.`);
    }
  }
  if (gmailConfigured()) {
    try {
      await sendViaSmtp({ to, subject, html, text });
      return { ok: true };
    } catch (err) {
      console.error(`✉  SMTP send failed: ${err.message} — writing to dev outbox instead.`);
    }
  }
  return writeToOutbox({ to, subject, html, text });
}

// --- Templates ---------------------------------------------------------------

function shell(title, bodyHtml) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#111">
  <div style="background:#0a0f1c;color:#fff;padding:20px 24px;border-radius:10px 10px 0 0">
    <span style="font-weight:800;font-size:22px">David Bond<span style="background:#3b82f6;color:#fff;border-radius:5px;padding:1px 7px;margin-left:4px">TV</span></span>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:24px">
    <h2 style="margin:0 0 12px">${title}</h2>
    ${bodyHtml}
    <p style="color:#6b7280;font-size:12px;margin-top:24px">If you didn't request this, you can safely ignore this email.</p>
  </div>
</div>`;
}

function button(url, label) {
  return `<p style="margin:20px 0"><a href="${url}" style="background:#3b82f6;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700;display:inline-block">${label}</a></p>
  <p style="font-size:13px;color:#6b7280;word-break:break-all">Or paste this link: <br>${url}</p>`;
}

export function sendVerificationEmail(to, link) {
  return sendMail({
    to,
    subject: 'Confirm your DavidBond.TV account',
    text: `Thank you for signing up for DavidBond.TV!\n\nConfirm your account: ${link}\n\nIf you didn't sign up, ignore this email.`,
    html: shell('Thanks for signing up!', `<p>Confirm your account to finish creating your DavidBond.TV profile.</p>${button(link, 'Confirm my account')}`),
  });
}

export function sendVerificationCodeEmail(to, code) {
  return sendMail({
    to,
    subject: 'Your DavidBond.TV verification code',
    text: `Your DavidBond.TV verification code is ${code}.\n\nThis code expires in 15 minutes. If you didn't sign up, ignore this email.`,
    html: shell('Verify your email', `<p>Enter this 6-digit code to finish creating your DavidBond.TV profile:</p>
      <p style="font-size:32px;letter-spacing:8px;font-weight:800;margin:22px 0">${code}</p>
      <p style="color:#6b7280">This code expires in 15 minutes.</p>`),
  });
}

export function sendResetEmail(to, link) {
  return sendMail({
    to,
    subject: 'Reset your DavidBond.TV password',
    text: `Reset your DavidBond.TV password: ${link}\n\nThis link expires in 1 hour. If you didn't request it, ignore this email.`,
    html: shell('Password reset', `<p>Click below to choose a new password. This link expires in 1 hour.</p>${button(link, 'Reset my password')}`),
  });
}

export function sendWelcomeEmail(to, username) {
  return sendMail({
    to,
    subject: 'Welcome to DavidBond.TV',
    text: `Welcome, ${username}! Your DavidBond.TV profile is ready.`,
    html: shell('Welcome to DavidBond.TV', `<p>Your profile <strong>${username}</strong> is all set. Enjoy the show!</p>`),
  });
}

export function sendMembershipGrantedEmail(to, link) {
  return sendMail({
    to,
    subject: 'Your DavidBond.TV membership is active',
    text: `Good news — you've been granted full membership on DavidBond.TV. All exclusive videos are now unlocked.\n\nStart watching: ${link}`,
    html: shell('Your membership is active 🎉', `<p>You've been granted full <strong>membership</strong> — every exclusive video is now unlocked for you.</p>${button(link, 'Start watching')}`),
  });
}

export function sendProductGrantedEmail(to, productName, link) {
  return sendMail({
    to,
    subject: `You now have access to ${productName}`,
    text: `Good news — you've been granted access to "${productName}" on DavidBond.TV.\n\nOpen it: ${link}`,
    html: shell('Access granted 🎉', `<p>You've been granted access to <strong>${productName}</strong>. It's ready whenever you are.</p>${button(link, `Open ${productName}`)}`),
  });
}

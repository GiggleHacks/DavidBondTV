import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createAccounts } from '../lib/accounts.js';
import { createChallenge } from '../lib/challenge.js';

const TOKEN_SECRET = 'test-token-secret';
const CHALLENGE_SECRET = 'test-challenge-secret';

let tmp;
let accounts;

function jsonReq(method, pathname, body, cookie = '') {
  const req = Readable.from([Buffer.from(JSON.stringify(body || {}))]);
  req.method = method;
  req.url = pathname;
  req.headers = { cookie };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

function fakeRes() {
  return {
    statusCode: null,
    headers: {},
    body: '',
    writeHead(status, headers = {}) { this.statusCode = status; this.headers = { ...this.headers, ...headers }; },
    setHeader(name, value) { this.headers[name] = value; },
    end(payload = '') { this.body = String(payload); },
    get json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

async function call(method, pathname, body, cookie = '') {
  const req = jsonReq(method, pathname, body, cookie);
  const res = fakeRes();
  await accounts.handle(req, res, new URL(`http://localhost${pathname}`));
  return res;
}

function signupBody(email = 'person@example.com') {
  const challenge = createChallenge(CHALLENGE_SECRET);
  return {
    email,
    password: 'correct horse battery',
    token: challenge.token,
    answer: challenge.answer,
    hp: '',
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbtv-auth-code-'));
  process.env.BASE_URL = 'http://localhost';
  accounts = createAccounts({
    tokenSecret: TOKEN_SECRET,
    challengeSecret: CHALLENGE_SECRET,
    baseUrl: 'http://localhost',
    usersFile: path.join(tmp, 'users.json'),
    mediaDir: path.join(tmp, 'media'),
  });
});

afterEach(() => {
  delete process.env.BASE_URL;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('email verification codes', () => {
  it('signup returns the code verification mode and a dev code in local mail mode', async () => {
    const res = await call('POST', '/api/auth/signup', signupBody());

    expect(res.statusCode).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.verification).toBe('code');
    expect(res.json.email).toBe('person@example.com');
    expect(res.json.devCode).toMatch(/^\d{6}$/);
    expect(res.json.verifyUrl).toBeUndefined();
  });

  it('verify-code marks the user verified, starts a session, and keeps profile incomplete', async () => {
    const signup = await call('POST', '/api/auth/signup', signupBody('verify@example.com'));
    const code = signup.json.devCode;

    const res = await call('POST', '/api/auth/verify-code', { email: 'verify@example.com', code });

    expect(res.statusCode).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.user.email).toBe('verify@example.com');
    expect(res.json.user.verified).toBe(true);
    expect(res.json.user.profileComplete).toBe(false);
    expect(String(res.headers['Set-Cookie'] || '')).toContain('dbtv_session=');
  });

  it('rejects expired or incorrect verification codes without verifying the account', async () => {
    const signup = await call('POST', '/api/auth/signup', signupBody('bad@example.com'));
    expect(signup.json.devCode).toMatch(/^\d{6}$/);

    const res = await call('POST', '/api/auth/verify-code', { email: 'bad@example.com', code: '000000' });

    expect(res.statusCode).toBe(400);
    expect(res.json.error).toMatch(/invalid|expired/i);
    expect(accounts.store.getByEmail('bad@example.com').verified).toBe(false);
  });

  it('resend-code rotates the stored code but keeps responses generic', async () => {
    const signup = await call('POST', '/api/auth/signup', signupBody('resend@example.com'));
    const first = signup.json.devCode;

    const res = await call('POST', '/api/auth/resend-code', { email: 'resend@example.com' });

    expect(res.statusCode).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.message).toMatch(/code/i);
    expect(res.json.devCode).toMatch(/^\d{6}$/);
    expect(res.json.devCode).not.toBe(first);
  });

  it('stores only a hash of the verification code on the user record', async () => {
    const signup = await call('POST', '/api/auth/signup', signupBody('hash@example.com'));
    const user = accounts.store.getByEmail('hash@example.com');

    expect(user.verifyCodeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(user.verifyCodeHash).not.toBe(signup.json.devCode);
    expect(user.verifyCodeExpiresAt).toBeGreaterThan(Date.now());
    expect(user.verifyCodeAttempts).toBe(0);
  });
});

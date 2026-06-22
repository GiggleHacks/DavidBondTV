import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendMail, resendConfigured, gmailConfigured, mailerConfigured } from '../lib/mailer.js';

const ENV_KEYS = ['BASE_URL', 'RESEND_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'MAIL_FROM'];
let saved;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  // A non-local BASE_URL is required for any real transport to engage.
  process.env.BASE_URL = 'https://davidbondtv.com';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe('mailer transport selection', () => {
  it('reports configured when Resend OR Gmail creds are present', () => {
    expect(mailerConfigured()).toBe(false);
    process.env.RESEND_API_KEY = 're_test';
    expect(resendConfigured()).toBe(true);
    expect(mailerConfigured()).toBe(true);
    delete process.env.RESEND_API_KEY;
    process.env.GMAIL_USER = 'a@gmail.com';
    process.env.GMAIL_APP_PASSWORD = 'pw';
    expect(gmailConfigured()).toBe(true);
    expect(mailerConfigured()).toBe(true);
  });

  it('sends via Resend when RESEND_API_KEY is set', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.MAIL_FROM = 'David Bond TV <noreply@davidbondtv.com>';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' });
    vi.stubGlobal('fetch', fetchMock);

    const r = await sendMail({ to: 'u@x.com', subject: 'Hi', html: '<b>h</b>', text: 't' });

    expect(r).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer re_test');
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({
      from: 'David Bond TV <noreply@davidbondtv.com>',
      to: ['u@x.com'],
      subject: 'Hi',
      html: '<b>h</b>',
      text: 't',
    });
  });

  it('falls back to the dev outbox when Resend returns an error', async () => {
    process.env.RESEND_API_KEY = 're_test';
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => 'bad domain' });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const r = await sendMail({ to: 'u@x.com', subject: 'Hi', text: 't' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.dev).toBe(true); // wrote to outbox instead of throwing
  });

  it('uses the dev outbox when no transport is configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await sendMail({ to: 'u@x.com', subject: 'Hi', text: 't' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.dev).toBe(true);
  });
});

import { requireAdmin } from './god-auth.js';

const $ = (id) => document.getElementById(id);
const fBotToken = $('f-bot-token');
const fBotUsername = $('f-bot-username');
const fChatId = $('f-chat-id');
const fGroupChatId = $('f-group-chat-id');
const fWebhookSecret = $('f-webhook-secret');
const btnSave = $('save-btn');
const btnTest = $('test-btn');
const msgSpan = $('msg');
const restartWarning = $('restart-warning');

let isSaving = false;

function showMsg(text, isError = false) {
  msgSpan.textContent = text;
  msgSpan.style.color = isError ? 'var(--danger, #ff4d4d)' : 'var(--text-dim)';
  setTimeout(() => { if (msgSpan.textContent === text) msgSpan.textContent = ''; }, 4000);
}

// --- Secret fields: masked by default (front half shown), toggle to reveal, copy ---

// Keep the front portion readable, mask the rest. We reveal at most the first
// half so the sensitive tail of a token/secret never shows while hidden.
function maskHalf(v) {
  if (!v) return '';
  const keep = Math.floor(v.length / 2);
  return v.slice(0, keep) + '•'.repeat(Math.min(v.length - keep, 12));
}

// The input holds the masked text when hidden; the real value lives in
// dataset.real. Read this anywhere the true value is needed (save).
function realValue(input) {
  return input.dataset.shown === '1' ? input.value : (input.dataset.real || '');
}

function renderSecret(input) {
  const real = input.dataset.real || '';
  if (input.dataset.shown === '1') {
    input.readOnly = false;
    input.value = real;
  } else {
    input.readOnly = true;
    input.value = maskHalf(real);
  }
}

// Set a secret field's underlying value (used when config loads).
function setSecret(input, val) {
  input.dataset.real = val || '';
  renderSecret(input);
}

function setupSecret(input) {
  // While revealed, keep dataset.real in sync as the user edits.
  input.addEventListener('input', () => {
    if (input.dataset.shown === '1') input.dataset.real = input.value;
  });

  const wrap = document.createElement('div');
  wrap.className = 'pr-secret';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'icon-btn';
  toggleBtn.textContent = 'Show';
  toggleBtn.addEventListener('click', () => {
    input.dataset.shown = input.dataset.shown === '1' ? '0' : '1';
    toggleBtn.textContent = input.dataset.shown === '1' ? 'Hide' : 'Show';
    renderSecret(input);
  });

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'icon-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', async () => {
    const val = realValue(input);
    if (!val) { showMsg('Nothing to copy', true); return; }
    try {
      await navigator.clipboard.writeText(val);
      copyBtn.textContent = 'Copied';
      copyBtn.classList.add('ok');
      setTimeout(() => { copyBtn.textContent = 'Copy'; copyBtn.classList.remove('ok'); }, 1500);
    } catch {
      showMsg('Copy failed', true);
    }
  });

  wrap.appendChild(toggleBtn);
  wrap.appendChild(copyBtn);

  input.dataset.shown = '0';
  setSecret(input, '');
}

const secretInputs = () => [...document.querySelectorAll('input[data-secret]')];

async function loadConfig() {
  try {
    const res = await fetch('/api/god/telegram/config');
    const r = await res.json();
    if (res.ok && r.config) {
      setSecret(fBotToken, r.config.TELEGRAM_BOT_TOKEN || '');
      fBotUsername.value = r.config.TELEGRAM_BOT_USERNAME || '';
      fChatId.value = r.config.TELEGRAM_CHAT_ID || '';
      fGroupChatId.value = r.config.TELEGRAM_GROUP_CHAT_ID || '';
      setSecret(fWebhookSecret, r.config.TELEGRAM_WEBHOOK_SECRET || '');
    }
  } catch (err) {
    console.error(err);
  }
}

async function saveConfig() {
  if (isSaving) return;
  isSaving = true;
  btnSave.textContent = 'Saving...';

  const config = {
    TELEGRAM_BOT_TOKEN: realValue(fBotToken).trim(),
    TELEGRAM_BOT_USERNAME: fBotUsername.value.trim(),
    TELEGRAM_CHAT_ID: fChatId.value.trim(),
    TELEGRAM_GROUP_CHAT_ID: fGroupChatId.value.trim(),
    TELEGRAM_WEBHOOK_SECRET: realValue(fWebhookSecret).trim(),
  };

  try {
    const res = await fetch('/api/god/telegram/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    const r = await res.json();
    if (!res.ok) {
      showMsg(r.error || 'Failed to save', true);
    } else {
      showMsg('Saved successfully!');
      restartWarning.style.display = 'block';
    }
  } catch (err) {
    showMsg('Network error', true);
  }

  isSaving = false;
  btnSave.textContent = 'Save settings to .env';
}

async function testBot() {
  btnTest.textContent = 'Sending...';
  try {
    const res = await fetch('/api/god/telegram/test', { method: 'POST' });
    const r = await res.json();
    if (!res.ok) {
      showMsg(r.error || 'Test failed', true);
    } else {
      showMsg('Test message sent!');
    }
  } catch (err) {
    showMsg('Network error', true);
  }
  btnTest.textContent = 'Test Bot';
}

async function init() {
  await requireAdmin();
  secretInputs().forEach(setupSecret);
  btnSave.addEventListener('click', saveConfig);
  btnTest.addEventListener('click', testBot);
  await loadConfig();
}

init();

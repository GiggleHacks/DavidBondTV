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

async function loadConfig() {
  try {
    const res = await fetch('/api/god/telegram/config');
    const r = await res.json();
    if (res.ok && r.config) {
      fBotToken.value = r.config.TELEGRAM_BOT_TOKEN || '';
      fBotUsername.value = r.config.TELEGRAM_BOT_USERNAME || '';
      fChatId.value = r.config.TELEGRAM_CHAT_ID || '';
      fGroupChatId.value = r.config.TELEGRAM_GROUP_CHAT_ID || '';
      fWebhookSecret.value = r.config.TELEGRAM_WEBHOOK_SECRET || '';
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
    TELEGRAM_BOT_TOKEN: fBotToken.value.trim(),
    TELEGRAM_BOT_USERNAME: fBotUsername.value.trim(),
    TELEGRAM_CHAT_ID: fChatId.value.trim(),
    TELEGRAM_GROUP_CHAT_ID: fGroupChatId.value.trim(),
    TELEGRAM_WEBHOOK_SECRET: fWebhookSecret.value.trim(),
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
  btnSave.addEventListener('click', saveConfig);
  btnTest.addEventListener('click', testBot);
  await loadConfig();
}

init();

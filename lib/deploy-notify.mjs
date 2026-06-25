// Boot-time deploy / reboot announcer.
//
// On every start we compare the running build (package version + git HEAD) against
// the last build we recorded. That tells a *fresh deploy* (version or commit
// changed) apart from a *plain restart* (same build). A deploy fires a system
// alert in the owner's notification bell AND a Telegram summary of what changed; a
// plain reboot fires only a quiet bell entry (no Telegram — restarts shouldn't
// spam the owner). The very first boot (no prior state) stays silent.
//
// All I/O that can fail (git, fs, Telegram) is guarded — this must never block or
// crash startup. Side-effects are injected so it's unit-testable.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function readBootState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function currentGitSha(cwd) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() || null;
  } catch { return null; }
}

/** One-line-per-commit subjects in (fromSha, toSha]. Empty if git/range unavailable. */
export function commitSummary(cwd, fromSha, toSha = 'HEAD', max = 12) {
  if (!fromSha) return [];
  try {
    const out = execFileSync('git', ['log', '--no-merges', '--pretty=format:%s', `${fromSha}..${toSha}`],
      { cwd, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (!out) return [];
    return out.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, max);
  } catch { return []; }
}

/**
 * Detect deploy-vs-reboot, fire the matching alerts, persist new state. Returns a
 * small descriptor ({ kind: 'first'|'update'|'reboot', … }) for logging/tests.
 */
export async function announceBoot({
  version, cwd, stateFile,
  notifyAdmins,               // (payload) => void — admin bell, required
  sendTelegram = null,        // (htmlText) => void|Promise — owner DM, optional
  now = Date.now(),
}) {
  const prev = readBootState(stateFile);
  const sha = currentGitSha(cwd);
  const firstBoot = !prev;
  const isUpdate = !!prev && (prev.version !== version || (!!sha && !!prev.sha && prev.sha !== sha));

  // Persist immediately so a crash-loop can't re-announce the same deploy forever.
  try {
    await fsp.mkdir(path.dirname(stateFile), { recursive: true });
    await fsp.writeFile(stateFile, JSON.stringify({ version, sha, ts: now }, null, 2));
  } catch { /* best-effort */ }

  if (firstBoot) return { kind: 'first', version };

  if (isUpdate) {
    const commits = commitSummary(cwd, prev.sha);
    if (notifyAdmins) {
      notifyAdmins({
        kind: 'system',
        title: `Site updated to v${version}`,
        body: commits.length ? commits.slice(0, 3).join(' · ') : `Now running v${version}.`,
        link: '/god.html',
      });
    }
    if (sendTelegram) {
      const head = prev.version !== version
        ? `🚀 <b>Site updated</b>  v${escapeHtml(prev.version)} → v${escapeHtml(version)}`
        : `🚀 <b>Site updated</b>  (v${escapeHtml(version)})`;
      const lines = commits.length
        ? commits.map((c) => `• ${escapeHtml(c)}`).join('\n')
        : '• (no commit details available)';
      try { await sendTelegram(`${head}\n\n${lines}`); } catch { /* best-effort */ }
    }
    return { kind: 'update', version, from: prev.version, commits: commits.length };
  }

  // Same build → a plain restart. Quiet bell entry only.
  if (notifyAdmins) {
    notifyAdmins({ kind: 'server', title: 'Server rebooted', body: `Back online — v${version}.`, link: '/god.html' });
  }
  return { kind: 'reboot', version };
}

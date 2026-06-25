// Headless local→server publish driver. Reuses lib/sync-client.startPublish (the
// same engine the admin "Publish to server" button uses) so the video artifacts +
// manifest entries push to production over authenticated HTTPS. Diff-based and
// resumable — re-running only sends what's missing/changed.
//
//   node --env-file=.env build/publish-to-prod.mjs
//
import { startPublish, getPublishJob } from '../lib/sync-client.mjs';

const targetUrl = (process.env.SYNC_TARGET_URL || '').replace(/\/+$/, '');
const token = process.env.SYNC_TOKEN || '';
if (!targetUrl || !token) { console.error('SYNC_TARGET_URL and SYNC_TOKEN must be set (run with --env-file=.env).'); process.exit(1); }
console.log(`Publishing to ${targetUrl} …`);

const fmtMB = (b) => `${(b / 1e6).toFixed(0)}MB`;
const { jobId } = startPublish({ targetUrl, token, now: Date.now() });

let last = '';
const timer = setInterval(() => {
  const j = getPublishJob(jobId);
  if (!j) return;
  const line = `[${j.phase}] ${j.pct}%  videos ${j.done}/${j.total}  ${fmtMB(j.bytesSent)}/${fmtMB(j.bytesTotal)}`
    + `  ${j.speed ? (j.speed / 1e6).toFixed(1) + 'MB/s' : ''}  ${j.current || ''}`;
  if (line !== last) { console.log(line); last = line; }
  if (j.status !== 'running') {
    clearInterval(timer);
    if (j.config) console.log(`config synced: ${j.config.categories} categories, ${j.config.coupons} coupons`);
    if (j.errors && j.errors.length) { console.error('ERRORS:', JSON.stringify(j.errors, null, 2)); }
    console.log(`\nFINISHED: status=${j.status} videos=${j.done}/${j.total} bytes=${fmtMB(j.bytesSent)}`);
    process.exit(j.status === 'done' ? 0 : 1);
  }
}, 2000);

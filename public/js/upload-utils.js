import {
  categoryDisplayName,
  categoryLabelWithVisual,
  categoryBadge as categoryVisualBadge,
} from './category-visuals.js';

export const RECENT_UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1000;

export function fmtSize(bytes) {
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

export function describeUploadError(status, detail, { maxUploadBytes } = {}) {
  if (status === 413) {
    const limit = typeof maxUploadBytes === 'number' && maxUploadBytes > 0 ? fmtSize(maxUploadBytes) : 'the allowed size';
    return `File too large — the limit is ${limit}.`;
  }
  if (status === 415) return 'Only .mp4/.mov/.m4v video files are accepted.';
  if (status === 429) return 'Uploads are temporarily throttled — wait a minute, then click Retry.';
  if (status === 401) return 'Your admin session expired — reload the page and sign in again.';
  if (status === 409) return detail || 'The upload fell out of sync with the server — Retry will resync and continue.';
  if (status === 502 || status === 503 || status === 504) {
    return `The server gateway dropped the connection (${status}). Your progress is saved — click Retry to resume.`;
  }
  if (!status) return 'Network connection lost. Your progress is saved — click Retry to resume.';
  if (status >= 500) return `The server hit an error (${status}). Your progress is saved — click Retry to resume.`;
  return detail || `Upload failed (${status}).`;
}

export function normalizeCategoryName(name) {
  return categoryDisplayName({ name });
}

export function categoryOptionLabel(category) {
  return categoryLabelWithVisual(category, 'Uncategorized');
}

export function categoryBadge(category) {
  return categoryVisualBadge(category);
}

export function filterRetainedJobs(jobs, now = Date.now(), retentionMs = RECENT_UPLOAD_RETENTION_MS) {
  return (jobs || []).filter((job) => {
    if (!job || typeof job !== 'object') return false;
    if (job.status !== 'ready') return true;
    if (!Number.isFinite(job.finishedAt)) return true;
    return now - job.finishedAt < retentionMs;
  });
}

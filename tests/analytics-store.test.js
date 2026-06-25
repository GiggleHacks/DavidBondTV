import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createAnalytics } from '../lib/analytics-store.mjs';

let dir;

beforeEach(async () => {
  dir = path.join(os.tmpdir(), `analytics-${crypto.randomUUID()}`);
  await fsp.mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('analytics retention defaults', () => {
  it('keeps raw logs for 30 days and rollups for 365 days by default', () => {
    const analytics = createAnalytics({ dir });

    expect(analytics.config.rawRetentionDays).toBe(30);
    expect(analytics.config.dayWindow).toBe(365);
  });
});

describe('activity logs', () => {
  it('stores expanded watch events and supports search, filters, and cursor paging', () => {
    const analytics = createAnalytics({ dir });
    analytics.record({
      t: Date.parse('2026-06-20T12:00:00Z'),
      video: 'bakersfield-ride',
      videoTitle: 'Bakersfield Ride',
      viewId: 'view-1',
      sessionId: 'session-1',
      userId: 'u1',
      username: 'david',
      subscriber: true,
      ip: '203.0.113.10',
      cc: 'US',
      country: 'United States',
      city: 'Bakersfield',
      region: 'California',
      lat: 35.3733,
      lon: -119.0187,
      dt: 22,
      pos: 42,
      dur: 300,
      deviceId: 'device-abc',
      device: { type: 'desktop', os: 'Windows', browser: 'Edge', viewport: '1440x900' },
    });
    analytics.recordBlocked({
      ip: '198.51.100.8',
      country: 'FR',
      geo: { country: 'France', city: 'Paris', lat: 48.8566, lon: 2.3522 },
      user: { id: 'u2', username: 'blocked-user' },
      device: { id: 'device-blocked', type: 'mobile' },
    }, 'country');
    analytics.flush(true);

    const filtered = analytics.queryLogs({ q: 'bakersfield', subscriber: true, limit: 10 });
    expect(filtered.events).toHaveLength(1);
    expect(filtered.events[0]).toMatchObject({
      type: 'watch',
      userId: 'u1',
      username: 'david',
      subscriber: true,
      ip: '203.0.113.10',
      cc: 'US',
      country: 'United States',
      city: 'Bakersfield',
      region: 'California',
      lat: 35.3733,
      lon: -119.0187,
      videoId: 'bakersfield-ride',
      videoTitle: 'Bakersfield Ride',
      deviceId: 'device-abc',
      sessionId: 'session-1',
      viewId: 'view-1',
      seconds: 22,
      position: 42,
      duration: 300,
    });
    const firstPage = analytics.queryLogs({ limit: 1 });
    expect(firstPage.events[0].type).toBe('blocked');
    expect(firstPage.nextCursor).toBeTruthy();

    const secondPage = analytics.queryLogs({ limit: 1, cursor: firstPage.nextCursor });
    expect(secondPage.events[0].type).toBe('watch');
  });

  it('exports filtered logs as CSV with escaped values', () => {
    const analytics = createAnalytics({ dir });
    analytics.record({
      t: Date.parse('2026-06-20T12:00:00Z'),
      video: 'comma-video',
      videoTitle: 'City, Night',
      viewId: 'view-1',
      userId: 'u1',
      username: 'david',
      ip: '203.0.113.10',
      cc: 'US',
      city: 'Fresno',
      dt: 5,
      deviceId: 'dev-1',
      device: { type: 'phone', browser: 'Safari' },
    });
    analytics.flush(true);

    const csv = analytics.exportLogsCsv({ q: 'fresno' });

    expect(csv.split('\n')[0]).toContain('timestamp,type,username,userId,subscriber,ip,country,countryCode,city,region,content,videoId,device,deviceId,sessionId,viewId,seconds,position,duration,reason');
    expect(csv).toContain('"City, Night"');
    expect(csv).toContain('Fresno');
  });
});

describe('traffic markers', () => {
  it('keeps nearby city markers separate and jitters only duplicate coordinates', () => {
    const analytics = createAnalytics({ dir });
    analytics.record({ t: Date.parse('2026-06-20T12:00:00Z'), video: 'v1', viewId: 'a', ip: '1.1.1.1', cc: 'US', city: 'Bakersfield', region: 'California', lat: 35.3733, lon: -119.0187, dt: 3 });
    analytics.record({ t: Date.parse('2026-06-20T12:01:00Z'), video: 'v2', viewId: 'b', ip: '1.1.1.2', cc: 'US', city: 'Fresno', region: 'California', lat: 36.7378, lon: -119.7871, dt: 3 });
    analytics.record({ t: Date.parse('2026-06-20T12:02:00Z'), video: 'v3', viewId: 'c', ip: '1.1.1.3', cc: 'US', city: 'Bakersfield', region: 'California', lat: 35.3733, lon: -119.0187, dt: 3 });
    analytics.flush(true);

    const markers = analytics.getTrafficMarkers({ from: '2026-06-20', to: '2026-06-20' });

    expect(markers).toHaveLength(3);
    const bakersfield = markers.filter((m) => m.city === 'Bakersfield');
    const fresno = markers.find((m) => m.city === 'Fresno');
    expect(fresno.lat).toBeCloseTo(36.7378, 4);
    expect(Math.abs(bakersfield[0].lat - bakersfield[1].lat)).toBeGreaterThan(0);
    expect(Math.abs(bakersfield[0].lat - fresno.lat)).toBeGreaterThan(1);
  });
});

describe('activity feed dedup', () => {
  it('collapses repeated heartbeats of one view into a single watched entry with summed seconds', () => {
    const analytics = createAnalytics({ dir });
    // Three heartbeats for the SAME view, interleaved with another viewer's view.
    analytics.record({ t: Date.parse('2026-06-20T12:00:00Z'), video: 'v1', videoTitle: 'V1', viewId: 'view-A', ip: '1.1.1.1', dt: 5, pos: 5 });
    analytics.record({ t: Date.parse('2026-06-20T12:00:05Z'), video: 'v1', videoTitle: 'V1', viewId: 'view-B', ip: '2.2.2.2', dt: 5, pos: 5 });
    analytics.record({ t: Date.parse('2026-06-20T12:00:10Z'), video: 'v1', videoTitle: 'V1', viewId: 'view-A', ip: '1.1.1.1', dt: 5, pos: 10 });
    analytics.record({ t: Date.parse('2026-06-20T12:00:20Z'), video: 'v1', videoTitle: 'V1', viewId: 'view-A', ip: '1.1.1.1', dt: 7, pos: 17 });

    const recent = analytics.getRecentEvents(50);
    // 4 raw heartbeats → 2 distinct views (A collapsed, B alone).
    expect(recent).toHaveLength(2);
    const a = recent.find((e) => e.viewId === 'view-A');
    expect(a.seconds).toBe(17);          // 5 + 5 + 7 summed
    expect(a.position).toBe(17);         // furthest position retained

    // Logs query collapses the same way.
    const logs = analytics.queryLogs({ from: '2026-06-20', to: '2026-06-20', limit: 50 });
    expect(logs.events.filter((e) => e.viewId === 'view-A')).toHaveLength(1);
  });
});

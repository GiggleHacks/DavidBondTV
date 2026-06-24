import { describe, expect, it } from 'vitest';
import {
  ADMIN_ROUTE_PREFIX,
  isLegacyAdminRoute,
  isPrettyAdminRoute,
  resolveAdminFilePath,
} from '../lib/admin-routes.js';

describe('admin-routes', () => {
  it('recognizes the new admin route family', () => {
    expect(isPrettyAdminRoute(ADMIN_ROUTE_PREFIX)).toBe(true);
    expect(isPrettyAdminRoute(`${ADMIN_ROUTE_PREFIX}-videos.html`)).toBe(true);
    expect(isPrettyAdminRoute(`${ADMIN_ROUTE_PREFIX}-upload.html`)).toBe(true);
    expect(isPrettyAdminRoute(`${ADMIN_ROUTE_PREFIX}-logs.html`)).toBe(true);
    expect(isPrettyAdminRoute('/browse.html')).toBe(false);
  });

  it('recognizes the legacy god route family', () => {
    expect(isLegacyAdminRoute('/god')).toBe(true);
    expect(isLegacyAdminRoute('/god.html')).toBe(true);
    expect(isLegacyAdminRoute('/god-users.html')).toBe(true);
    expect(isLegacyAdminRoute(ADMIN_ROUTE_PREFIX)).toBe(false);
  });

  it('maps the new pretty admin urls onto the existing files', () => {
    expect(resolveAdminFilePath(ADMIN_ROUTE_PREFIX)).toBe('/god.html');
    expect(resolveAdminFilePath(`${ADMIN_ROUTE_PREFIX}-analytics.html`)).toBe('/god-analytics.html');
    expect(resolveAdminFilePath(`${ADMIN_ROUTE_PREFIX}-logs.html`)).toBe('/god-logs.html');
    expect(resolveAdminFilePath(`${ADMIN_ROUTE_PREFIX}-edit.html`)).toBe('/god-edit.html');
  });

  it('refuses to resolve legacy or unrelated routes', () => {
    expect(resolveAdminFilePath('/god')).toBe(null);
    expect(resolveAdminFilePath('/god-videos.html')).toBe(null);
    expect(resolveAdminFilePath('/login.html')).toBe(null);
  });
});

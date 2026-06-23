export const ADMIN_ROUTE_PREFIX = '/gigglehacksclicking85hgfd7845789drghudr789rdhkjrtbi8r5eg9875g789';

const ADMIN_ROUTE_SUFFIXES = [
  '',
  '.html',
  '-upload.html',
  '-videos.html',
  '-users.html',
  '-community.html',
  '-products.html',
  '-pricing.html',
  '-coupons.html',
  '-categories.html',
  '-analytics.html',
  '-edit.html',
  '-review.html',
];

const ADMIN_FILE_MAP = new Map([
  [ADMIN_ROUTE_PREFIX, '/god.html'],
  [`${ADMIN_ROUTE_PREFIX}.html`, '/god.html'],
  [`${ADMIN_ROUTE_PREFIX}-upload.html`, '/god-upload.html'],
  [`${ADMIN_ROUTE_PREFIX}-videos.html`, '/god-videos.html'],
  [`${ADMIN_ROUTE_PREFIX}-users.html`, '/god-users.html'],
  [`${ADMIN_ROUTE_PREFIX}-community.html`, '/god-community.html'],
  [`${ADMIN_ROUTE_PREFIX}-products.html`, '/god-products.html'],
  [`${ADMIN_ROUTE_PREFIX}-pricing.html`, '/god-pricing.html'],
  [`${ADMIN_ROUTE_PREFIX}-coupons.html`, '/god-coupons.html'],
  [`${ADMIN_ROUTE_PREFIX}-categories.html`, '/god-categories.html'],
  [`${ADMIN_ROUTE_PREFIX}-analytics.html`, '/god-analytics.html'],
  [`${ADMIN_ROUTE_PREFIX}-edit.html`, '/god-edit.html'],
  [`${ADMIN_ROUTE_PREFIX}-review.html`, '/god-review.html'],
]);

export function isLegacyAdminRoute(pathname) {
  return pathname === '/god' || pathname === '/god.html' || pathname.startsWith('/god-');
}

export function isPrettyAdminRoute(pathname) {
  return ADMIN_ROUTE_SUFFIXES.some((suffix) => pathname === `${ADMIN_ROUTE_PREFIX}${suffix}`);
}

export function resolveAdminFilePath(pathname) {
  return ADMIN_FILE_MAP.get(pathname) || null;
}

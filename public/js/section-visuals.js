// Per-section visual identity for the admin backend. Single source of truth for
// the colour + icon of every god-* section, mirroring the category-visuals.js
// pattern. Consumed by admin-shell.js to render the nav, page header, and to
// theme each page via the --section-accent custom property.
//
// `route` is the admin path suffix WITHOUT the .html extension ('' = dashboard).
// `nav: true` means the section shows in the top nav bar; sub-pages (analytics,
// review, edit) still get an identity for their header but aren't top-level nav.
// `dark: true` flips icon/text contrast to a dark ink for bright accents.

export const SECTIONS = [
  { key: 'dashboard',  label: 'Dashboard',  route: '',            icon: 'dashboard', accent: '#818cf8', nav: true,  desc: 'Live control deck — traffic, viewers, geo-defense.' },
  { key: 'dashboard2', label: 'Dashboard 2.0', route: '-dashboard2', icon: 'dashboard2', accent: '#f43f5e', nav: true,  desc: 'Next-generation real-time command center.' },
  { key: 'upload',     label: 'Upload',     route: '-upload',     icon: 'upload',    accent: '#22d3ee', nav: true,  dark: true,  desc: 'Add new videos and track processing.' },
  { key: 'videos',     label: 'Videos',     route: '-videos',     icon: 'video',     accent: '#3b82f6', nav: true,  desc: 'Manage the library — publish, tag, organize.' },
  { key: 'products',   label: 'Products',   route: '-products',   icon: 'package',   accent: '#34d399', nav: true,  dark: true,  desc: 'Courses and one-time purchases.' },
  { key: 'pricing',    label: 'Pricing',    route: '-pricing',    icon: 'tag',       accent: '#f59e0b', nav: true,  dark: true,  desc: 'Subscription plans and tiers.' },
  { key: 'categories', label: 'Categories', route: '-categories', icon: 'folder',    accent: '#a855f7', nav: true,  desc: 'Organize videos with icons and flags.' },
  { key: 'coupons',    label: 'Coupons',    route: '-coupons',    icon: 'ticket',    accent: '#fb7185', nav: true,  desc: 'Discount codes and promotions.' },
  { key: 'users',      label: 'Users',      route: '-users',      icon: 'users',     accent: '#2dd4bf', nav: true,  dark: true,  desc: 'Members, subscribers, and access.' },
  { key: 'logs',       label: 'Logs',       route: '-logs',       icon: 'analytics', accent: '#eab308', nav: true,  dark: true,  desc: 'Activity history, visitors, devices, and security events.' },
  { key: 'community',  label: 'Community',  route: '-community',  icon: 'community', accent: '#fb923c', nav: true,  dark: true,  desc: 'Comments and viewer engagement.' },
  { key: 'telegram',   label: 'Telegram',   route: '-telegram',   icon: 'telegram',  accent: '#38bdf8', nav: true,  dark: true,  desc: 'Bot configuration and group access.' },
  { key: 'review',     label: 'Review',     route: '-review',     icon: 'review',    accent: '#a3e635', nav: true,  dark: true,  desc: 'Approve or reject the draft queue.' },
  // Contextual sub-pages — identity for headers/theming, not in the nav.
  { key: 'analytics',  label: 'Analytics',  route: '-analytics',  icon: 'analytics', accent: '#4ade80', nav: false, dark: true,  desc: 'Per-video performance.' },
  { key: 'edit',       label: 'Edit',       route: '-edit',       icon: 'edit',      accent: '#94a3b8', nav: false, dark: true,  desc: 'Edit a single video.' },
];

const BY_KEY = new Map(SECTIONS.map((s) => [s.key, s]));

export const NAV_SECTIONS = SECTIONS.filter((s) => s.nav);

export function sectionByKey(key) {
  return BY_KEY.get(key) || null;
}

// Resolve the active section + admin route prefix from the current URL. The
// obfuscated admin prefix is never hardcoded — we strip the known route suffix
// off location.pathname so the secret path stays in one place (the URL itself).
// A page may override via body[data-admin-section] / body[data-admin-prefix]
// (used by the offline preview harness).
export function resolveSectionContext(pathname, body) {
  const ds = (body && body.dataset) || {};
  let prefix = ds.adminPrefix;
  let key = ds.adminSection;
  if (!key || prefix == null) {
    const path = String(pathname || '');
    const suffixed = SECTIONS.filter((s) => s.route).sort((a, b) => b.route.length - a.route.length);
    let matched = null;
    for (const s of suffixed) {
      if (path.endsWith(`${s.route}.html`)) { matched = s; break; }
    }
    if (matched) {
      if (!key) key = matched.key;
      if (prefix == null) prefix = path.slice(0, path.length - (matched.route.length + 5));
    } else {
      if (!key) key = 'dashboard';
      if (prefix == null) prefix = path.endsWith('.html') ? path.slice(0, -5) : path;
    }
  }
  return { key, prefix, section: sectionByKey(key) || SECTIONS[0] };
}

// Build the href for a section given the resolved admin prefix. Dashboard is the
// bare prefix (no .html); everything else is prefix + route + '.html'.
export function sectionHref(prefix, section) {
  if (!section || !section.route) return prefix || '/';
  return `${prefix}${section.route}.html`;
}

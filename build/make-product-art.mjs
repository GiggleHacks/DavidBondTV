// Generates the branding art for the Digital Pickup 2.0 course and the Products
// storefront as vector SVG, then rasterizes to PNG/JPG with sharp. Re-runnable.
// Theme: black / white / green "hacker" — a hooded-figure silhouette, white
// wordmark with a green "PICKUP" accent, matching the brand logo.
//
//   node build/make-product-art.mjs
//
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PRODUCT_ASSETS = path.join(ROOT, 'content', 'product-assets');
const BRAND = path.join(ROOT, 'public', 'brand');
fs.mkdirSync(PRODUCT_ASSETS, { recursive: true });
fs.mkdirSync(BRAND, { recursive: true });

const GREEN = '#2fe06f';
const GREEN2 = '#13c257';
const WHITE = '#ffffff';
const BLACK = '#000000';
const MONO = "Consolas, 'Courier New', monospace";
const SANS = "'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

/** Shared <defs>: green glow, faint green grid, green corner glows. */
function defs(id) {
  return `
  <defs>
    <filter id="glow-${id}" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="5" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <pattern id="grid-${id}" width="44" height="44" patternUnits="userSpaceOnUse">
      <path d="M44 0H0V44" fill="none" stroke="${GREEN}" stroke-opacity="0.08" stroke-width="1"/>
    </pattern>
    <radialGradient id="glowG-${id}" cx="0.5" cy="0.18" r="0.75">
      <stop offset="0" stop-color="${GREEN}" stop-opacity="0.30"/>
      <stop offset="1" stop-color="${GREEN}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="vig-${id}" cx="0.5" cy="0.45" r="0.75">
      <stop offset="0.5" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.6"/>
    </radialGradient>
  </defs>`;
}

function backdrop(id, w, h) {
  return `
    <rect width="${w}" height="${h}" fill="${BLACK}"/>
    <rect width="${w}" height="${h}" fill="url(#grid-${id})"/>
    <rect width="${w}" height="${h}" fill="url(#glowG-${id})"/>
    <rect width="${w}" height="${h}" fill="url(#vig-${id})"/>`;
}

// Hooded-figure silhouette in a local 300×380 box: white hood + shoulders with a
// carved (background-coloured) face void. `face` is the colour to carve with.
function hood(face) {
  return `
    <path d="M150 6
      C112 6 80 64 70 150
      C44 172 20 244 14 332
      C14 350 14 380 14 380
      L286 380
      C286 380 286 350 286 332
      C280 244 256 172 230 150
      C220 64 188 6 150 6 Z" fill="${WHITE}"/>
    <path d="M150 78
      C126 78 110 106 110 152
      C110 198 128 234 150 240
      C172 234 190 198 190 152
      C190 106 174 78 150 78 Z" fill="${face}"/>`;
}

// "THE" in a green outlined box (matches the brand mark).
function theBox(x, y) {
  return `
    <g transform="translate(${x},${y})">
      <rect x="0" y="0" width="86" height="50" rx="8" fill="none" stroke="${GREEN}" stroke-width="4"/>
      <text x="43" y="35" text-anchor="middle" font-family="${SANS}" font-size="28" font-weight="800" letter-spacing="3" fill="${GREEN}">THE</text>
    </g>`;
}

// --- Course logo (transparent PNG) -----------------------------------------
function courseLogoSVG() {
  const w = 1360; const h = 380; const id = 'cl';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
  ${defs(id)}
  ${theBox(24, 158)}
  <text x="124" y="252" font-family="${SANS}" font-size="104" font-weight="800" letter-spacing="1" fill="${WHITE}">DIGITAL</text>
  <g transform="translate(536,2) scale(0.95)" filter="url(#glow-${id})">${hood('#00000000')}</g>
  <text x="842" y="252" font-family="${SANS}" font-size="104" font-weight="800" letter-spacing="1" fill="${GREEN}" filter="url(#glow-${id})">PICKUP</text>
  <text x="1244" y="252" font-family="${SANS}" font-size="46" font-weight="700" fill="${WHITE}">2.0</text>
</svg>`;
}

// --- Course hero background (JPG) — black with faint hood watermark ----------
function courseBgSVG() {
  const w = 1600; const h = 900; const id = 'cb';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
  ${defs(id)}
  ${backdrop(id, w, h)}
  <g transform="translate(650,150) scale(0.85)" opacity="0.05">${hood(BLACK)}</g>
  <path d="M0 700 H1600" stroke="${GREEN}" stroke-width="2" stroke-opacity="0.22" filter="url(#glow-${id})"/>
</svg>`;
}

// --- Products storefront logo (transparent PNG) ----------------------------
function productsLogoSVG() {
  const w = 1180; const h = 300; const id = 'pl';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
  ${defs(id)}
  <g transform="translate(44,66)" filter="url(#glow-${id})">
    <path d="M16 60 L96 22 L176 60 L96 98 Z" fill="none" stroke="${GREEN}" stroke-width="8"/>
    <path d="M16 60 V150 L96 188 V98 Z" fill="none" stroke="${WHITE}" stroke-width="7" stroke-opacity="0.85"/>
    <path d="M176 60 V150 L96 188 V98 Z" fill="none" stroke="${GREEN}" stroke-width="7" stroke-opacity="0.85"/>
  </g>
  <text x="272" y="150" font-family="${SANS}" font-size="116" font-weight="800" letter-spacing="2" fill="${WHITE}" filter="url(#glow-${id})">PRODUCTS</text>
  <text x="276" y="206" font-family="${SANS}" font-size="29" font-weight="600" letter-spacing="7" fill="${GREEN}">DAVID BOND TV &#183; COURSES &amp; DOWNLOADS</text>
</svg>`;
}

// --- Products storefront hero background (JPG) ------------------------------
function productsHeroSVG() {
  const w = 1920; const h = 760; const id = 'ph';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
  ${defs(id)}
  ${backdrop(id, w, h)}
  <path d="M0 560 H1920" stroke="${GREEN}" stroke-width="2" stroke-opacity="0.2" filter="url(#glow-${id})"/>
</svg>`;
}

async function emitPNG(svg, outPath) {
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  console.log('  png →', path.relative(ROOT, outPath));
}
async function emitJPG(svg, outPath) {
  await sharp(Buffer.from(svg)).flatten({ background: BLACK }).jpeg({ quality: 86 }).toFile(outPath);
  console.log('  jpg →', path.relative(ROOT, outPath));
}

async function main() {
  console.log('Course assets:');
  await emitPNG(courseLogoSVG(), path.join(PRODUCT_ASSETS, 'logo-prod_digital_pickup.png'));
  await emitJPG(courseBgSVG(), path.join(PRODUCT_ASSETS, 'bg-prod_digital_pickup.jpg'));
  console.log('Storefront assets:');
  await emitPNG(productsLogoSVG(), path.join(BRAND, 'products-logo.png'));
  await emitJPG(productsHeroSVG(), path.join(BRAND, 'products-hero.jpg'));
  // Dark composite previews (so white wordmarks are visible for verification).
  const logoOnBg = async (logoSvg, bgPath, out) => {
    const logo = await sharp(Buffer.from(logoSvg)).resize({ width: 1100 }).png().toBuffer();
    await sharp(bgPath).resize(1280, 720, { fit: 'cover' })
      .composite([{ input: logo, gravity: 'centre' }]).png().toFile(out);
    console.log('  preview →', path.relative(ROOT, out));
  };
  console.log('Previews:');
  await logoOnBg(courseLogoSVG(), path.join(PRODUCT_ASSETS, 'bg-prod_digital_pickup.jpg'), path.join(__dirname, '_preview-course.png'));
  await logoOnBg(productsLogoSVG(), path.join(BRAND, 'products-hero.jpg'), path.join(__dirname, '_preview-products.png'));
  console.log('Done.');
}
main().catch((e) => { console.error('art failed:', e.message); process.exit(1); });

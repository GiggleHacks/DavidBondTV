// Generates the 3 default human-style avatars into public/avatars/:
//   person-glasses.svg, hacker.svg, hoodie.svg
// Flat illustrated "people" (not photos), self-contained, theme-neutral.
// Re-run to regenerate; output is stable.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'avatars');
const S = 120; // viewBox size

function frame(bg, inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" role="img">`
    + `<rect width="${S}" height="${S}" fill="${bg}"/>${inner}</svg>\n`;
}

// 1) Person with glasses — friendly, warm background, round specs.
const glasses = frame('#4f86c6', `
  <circle cx="60" cy="46" r="24" fill="#f2c79a"/>
  <path d="M30 112c0-19 14-32 30-32s30 13 30 32z" fill="#2f5d8a"/>
  <path d="M40 30c4-10 36-10 40 0 3 7 1 14-2 16-2-9-36-9-38 0-3-2-3-9 0-16z" fill="#3a2c20"/>
  <g fill="none" stroke="#222" stroke-width="3">
    <circle cx="49" cy="48" r="9"/><circle cx="71" cy="48" r="9"/>
    <line x1="58" y1="48" x2="62" y2="48"/><line x1="40" y1="46" x2="40" y2="46"/>
  </g>
  <path d="M52 62q8 6 16 0" fill="none" stroke="#b9785a" stroke-width="3" stroke-linecap="round"/>`);

// 2) Hacker — dark hoodie + green visor over the eyes, "anonymous" vibe.
const hacker = frame('#101a14', `
  <path d="M24 116c0-26 16-40 36-40s36 14 36 40z" fill="#13351f"/>
  <path d="M60 26c-22 0-34 16-34 40 0 6 1 10 3 14 4-22 16-30 31-30s27 8 31 30c2-4 3-8 3-14 0-24-12-40-34-40z" fill="#0c241a"/>
  <circle cx="60" cy="54" r="22" fill="#1a1f1c"/>
  <rect x="42" y="48" width="36" height="11" rx="5" fill="#0a0f0c"/>
  <circle cx="51" cy="53" r="3.2" fill="#22e06a"/><circle cx="69" cy="53" r="3.2" fill="#22e06a"/>`);

// 3) Hoodie — casual person in a pulled-up hoodie, neutral face.
const hoodie = frame('#c1556b', `
  <path d="M22 118c0-24 17-38 38-38s38 14 38 38z" fill="#e7e1d8"/>
  <circle cx="60" cy="50" r="22" fill="#e8b58c"/>
  <path d="M60 24c-21 0-33 15-33 38l9 3c0-20 10-29 24-29s24 9 24 29l9-3c0-23-12-38-33-38z" fill="#7a4a8c"/>
  <path d="M44 78c5 8 27 8 32 0l8 4c-6 12-42 12-48 0z" fill="#7a4a8c"/>
  <circle cx="52" cy="50" r="2.6" fill="#3a2a22"/><circle cx="68" cy="50" r="2.6" fill="#3a2a22"/>
  <path d="M53 62q7 5 14 0" fill="none" stroke="#b9785a" stroke-width="3" stroke-linecap="round"/>`);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'person-glasses.svg'), glasses, 'utf8');
fs.writeFileSync(path.join(OUT, 'hacker.svg'), hacker, 'utf8');
fs.writeFileSync(path.join(OUT, 'hoodie.svg'), hoodie, 'utf8');
console.log(`Wrote 3 avatars to ${OUT}`);

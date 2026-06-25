// One-off batch ingest for the "Digital Pickup 2.0" course. Reuses the live
// pipeline (lib/ingest.mjs enqueue → startEncode → editVideo → publish) so the
// course videos are encoded with the EXACT same compression/ladder as every
// other video on the site — no special ffmpeg settings here.
//
// For each source file it: copies the original into media/originals, enqueues it
// (free visibility — access is gated by the product, not the premium tier),
// triggers encoding, waits for `ready`, sets the clean title + neutral
// description, then publishes it. The trailer is ingested the same way but left
// UNassigned to any product so it stays publicly watchable on the sales page.
//
// Resumable: results are journaled to build/dp-ingest-result.json keyed by the
// source path, so re-running skips anything already encoded + ready.
//
//   node build/ingest-digital-pickup.mjs
//
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  enqueue, startEncode, editVideo, listManifest, listJobs, bulkAction, newUploadTarget,
} from '../lib/ingest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = 'D:\\Local\\Digital Products\\The Digital Pickup - A Hackers Guide To Meeting Women Online';
const COURSE = path.join(SRC_ROOT, 'Organized_Course');
const RESULT_FILE = path.join(__dirname, 'dp-ingest-result.json');

// Ordered course lessons: [relativePathUnderCourse, chapter, title, description].
const LESSONS = [
  ['01 - Chapter 1 - Introduction/01 - Not Only Tinder.mp4', 1, 'Not Only Tinder',
    'The course philosophy and ground rules. David frames Digital Pickup as a technical, systems-first approach to meeting women online across Tinder, Bumble, Instagram and Seeking Arrangements. Note: many tactics shown violate platform Terms of Service and are presented for educational purposes only.'],

  ['02 - Chapter 2 - Tinder/01 - Have Good Tinder Pictures.mp4', 2, 'Have Good Tinder Pictures',
    'How to build a profile that reads as fun, social and non-creepy — lead with humor, group shots and active-lifestyle photos instead of mirror selfies.'],
  ['02 - Chapter 2 - Tinder/02 - Google Account.mp4', 2, 'Google Account & Your Elo Score',
    'Why Tinder ties your internal Elo ranking to your Google Play account and device — not just your profile — and the case for a periodic "hard reset" to regain the new-account boost.'],
  ['02 - Chapter 2 - Tinder/03 - Make a Google Account and That\'s True.mp4', 2, 'Make a Clean Google Account',
    'Setting up a fresh secondary Android device and a clean Google account, including controlling the device from a PC and using text-verification services at sign-up.'],
  ['02 - Chapter 2 - Tinder/04 - Golden Switch.mp4', 2, 'The Golden Switch',
    'A ranking technique: build a fresh profile, let local activity raise its internal score, then swap the photos back to your own before matching.'],
  ['02 - Chapter 2 - Tinder/05 - Where Not to Get These Photos.mp4', 2, 'Where (Not) to Get Profile Photos',
    'A deeper walkthrough of the Golden Switch, why duplicate or stock images get flagged, and where to source realistic original photos instead.'],
  ['02 - Chapter 2 - Tinder/06 - Fully Exploit Tinder\'s Return Policy.mp4', 2, "Fully Exploit Tinder's Return Policy",
    "The mechanics of Tinder's 14-day refund window, why personal cards get blacklisted after a refund, and how anonymous payment changes the math."],
  ['02 - Chapter 2 - Tinder/07 - Why We Need to Get a Gift Card to Begin With.mp4', 2, 'Why You Need a Gift Card',
    'How cash-bought Google Play gift cards keep purchases anonymous, and how a refunded balance can be reused on fresh accounts.'],
  ['02 - Chapter 2 - Tinder/08 - Gift Card.mp4', 2, 'Gift-Card Refund, Step by Step',
    'A live, end-to-end walkthrough of the gift-card refund process, from buying the card to requesting the refund in Google Play billing.'],
  ['02 - Chapter 2 - Tinder/09 - Scripting and Automating Your Workflow.mp4', 2, 'Scripting & Automating Your Workflow',
    'Using Android text shortcuts and click macros to auto-answer common questions and automate repetitive swiping and opening messages at scale.'],

  ['03 - Chapter 3 - Instagram/01 - Tinder and Girl.mp4', 3, 'Why Instagram Beats Tinder',
    'Why Instagram has become a higher-trust platform for meeting women than a burned-out Tinder, and how the dynamic differs by country.'],
  ['03 - Chapter 3 - Instagram/02 - A Couple Concepts and How You Can Mimic It.mp4', 3, 'Profile Concepts You Can Mimic',
    "The elements of an attractive Instagram profile — why follower count doesn't matter and why Story Highlights act as social proof of an interesting life."],
  ['03 - Chapter 3 - Instagram/03 - Modeling Agency.mp4', 3, 'The Story-Push Idea',
    'The origin of "story pushing": converting your profile to a business account and running cheap local story ads to start conversations.'],
  ['03 - Chapter 3 - Instagram/04 - What Stories to Post in Another Episode.mp4', 3, 'What Stories to Post (Story-Push Setup)',
    'The technical setup for story pushing: business account, ad targeting by age and city, and using a simple poll to capture engagement.'],
  ['03 - Chapter 3 - Instagram/05 - Not Message.mp4', 3, 'Converting Poll Voters (Warm DMs)',
    'Turning passive poll voters into conversations by checking the voter list and opening warm DMs that earn high response rates.'],
  ['03 - Chapter 3 - Instagram/06 - Sending Cold.mp4', 3, 'Sending Cold DMs at Scale',
    'Finding local profiles via geotags, filtering them, using templated openers, and scaling cold outreach with scripts or assistants.'],

  ['04 - Chapter 4 - Bumble/01 - The Profile.mp4', 4, 'Bumble Profile & Auto-Swipe Scripting',
    'Setting up a Bumble profile and an auto-clicker script to collect matches hands-free on a secondary device.'],

  ['05 - Chapter 5 - Digital Pickup 2.0/01 - Tinder Account.mp4', 5, 'New Tinder Account (Shadow-Ban Bypass)',
    'Working around shadow-bans by creating and provisioning new accounts in a desktop browser before ever signing in on the phone.'],
  ['05 - Chapter 5 - Digital Pickup 2.0/02 - Banning Girls on Tinder I Like.mp4', 5, 'The Three-Tap Ban Trap',
    "How Tinder's automated report system works and how the tactic is used — presented so you understand the mechanic."],
  ['05 - Chapter 5 - Digital Pickup 2.0/03 - Simple Login.mp4', 5, 'Refund Hopping 2.0 (Privacy.com)',
    'An updated refund approach using virtual burner debit cards instead of physical gift cards and many Gmail accounts.'],
  ['05 - Chapter 5 - Digital Pickup 2.0/04 - Digital Pickup.mp4', 5, 'The Passport — Geography Is Everything',
    'Why location shapes online-dating results more than any profile tweak, with David\'s contrasting experiences across countries.'],
  ['05 - Chapter 5 - Digital Pickup 2.0/05 - Close Friends.mp4', 5, 'The Close Friends Trick',
    "Using Instagram's Close Friends list to re-engage matches with high-status \"bait\" posts that prompt them to message first."],
  ['05 - Chapter 5 - Digital Pickup 2.0/06 - Celebrity Trick.mp4', 5, 'The Celebrity Trick (Social Proof)',
    'Manufacturing social proof with purchased engagement and verified-account comments to stand out in a crowded inbox — presented as a mechanic to understand.'],
  ['05 - Chapter 5 - Digital Pickup 2.0/07 - Seeking Arrangements.mp4', 5, 'Seeking Arrangements',
    'Treating Seeking Arrangements as a high-response alternative: building a favorites list for free, then messaging during a short membership.'],
  ['05 - Chapter 5 - Digital Pickup 2.0/08 - Two Girls.mp4', 5, 'Two Girls (Group Dynamics)',
    'A candid case study on casual, non-judgmental framing and group dynamics.'],
  ['05 - Chapter 5 - Digital Pickup 2.0/09 - Have Sex.mp4', 5, 'Filming With Consent (GoPro)',
    'Guidelines for filming intimacy, with heavy emphasis that you must never record without explicit, enthusiastic consent.'],

  ['06 - Chapter 6 - First Date Game/01 - Fruit Ninja.mp4', 6, 'The Fruit-Ninja Date Structure',
    'David\'s three-part date structure since 2012: a sit-down activity, a stand-up activity, and a low-pressure reason to continue at your place.'],
  ['06 - Chapter 6 - First Date Game/02 - Guys Some Examples From My Real Life.mp4', 6, 'Real-Life Date Examples & Logistics',
    'Why logistics decide date outcomes — choosing venues close to home and leading the plan confidently, with real examples.'],
];

const TRAILER = [
  path.join(SRC_ROOT, 'How I Meet Girls Online - The REAL TRUTH.mp4'),
  'Digital Pickup 2.0 — Official Trailer',
  "The official trailer for Digital Pickup 2.0, David Bond's complete hacker's guide to meeting women online.",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function loadResult() {
  try { return JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8')); } catch { return { byKey: {}, trailerId: null, lessons: [] }; }
}
function saveResult(r) { fs.writeFileSync(RESULT_FILE, JSON.stringify(r, null, 2)); }
const entryById = (id) => listManifest().find((e) => e.id === id) || null;

/** Wait until a manifest entry with `id` reaches one of `states` (or time out). */
async function waitForStatus(id, states, { timeoutMs = 60 * 60 * 1000, label = '' } = {}) {
  const t0 = Date.now();
  let lastPct = -1;
  for (;;) {
    const e = entryById(id);
    if (e && states.includes(e.status || 'ready')) return e;
    if (e && e.status === 'failed') throw new Error(`encode failed for ${id}`);
    const job = listJobs().find((j) => j.manifestId === id);
    if (job && typeof job.pct === 'number' && job.pct !== lastPct) {
      lastPct = job.pct;
      process.stdout.write(`\r    ${label} … ${job.label || ''} ${job.pct}%   `);
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${id} → ${states}`);
    await sleep(1500);
  }
}

async function ingestOne(srcPath, title, description, { isTrailer = false } = {}) {
  if (!fs.existsSync(srcPath)) throw new Error(`source missing: ${srcPath}`);
  const { savedPath } = newUploadTarget(path.basename(srcPath));
  fs.copyFileSync(srcPath, savedPath);
  const { manifestId } = enqueue(savedPath, title, { visibility: 'free' });
  // Wait for the entry to be committed in the 'uploaded' state (prep does a probe
  // + poster frame) before kicking off the CPU-heavy encode.
  await waitForStatus(manifestId, ['uploaded'], { timeoutMs: 5 * 60 * 1000, label: 'prep' });
  await startEncode([manifestId]);
  await waitForStatus(manifestId, ['ready'], { label: `encode "${title}"` });
  // Set the clean title + neutral description (encode resets description to '').
  const ed = await editVideo(manifestId, { title, description });
  if (!ed.ok) throw new Error(`editVideo failed for ${manifestId}: ${ed.error}`);
  // Publish so purchasers (and the owner) can actually watch it. The trailer is
  // published too (it's free marketing); only its product-assignment differs.
  await bulkAction([manifestId], 'publish');
  process.stdout.write(`\r    ✓ ${title}  →  ${manifestId}${isTrailer ? '  (trailer)' : ''}\n`);
  return manifestId;
}

async function main() {
  const result = loadResult();

  // Trailer first (so the sales page has something even mid-run).
  if (!result.trailerId || !entryById(result.trailerId)) {
    console.log('\n[trailer]');
    result.trailerId = await ingestOne(TRAILER[0], TRAILER[1], TRAILER[2], { isTrailer: true });
    saveResult(result);
  } else {
    console.log(`\n[trailer] already done → ${result.trailerId}`);
  }

  console.log('\n[lessons]');
  const lessons = [];
  for (let i = 0; i < LESSONS.length; i += 1) {
    const [rel, chapter, title, description] = LESSONS[i];
    const key = rel;
    const prev = result.byKey[key];
    let id = prev && prev.id;
    const done = id && (entryById(id)?.status === 'ready');
    if (done) {
      process.stdout.write(`    • ${String(i + 1).padStart(2)}. ${title} — already done (${id})\n`);
    } else {
      process.stdout.write(`    • ${String(i + 1).padStart(2)}. ${title}\n`);
      id = await ingestOne(path.join(COURSE, rel), title, description);
      result.byKey[key] = { id, title, chapter };
      saveResult(result);
    }
    lessons.push({ order: i + 1, chapter, title, id });
  }
  result.lessons = lessons;
  saveResult(result);

  console.log('\nDONE.');
  console.log(`trailer: ${result.trailerId}`);
  console.log(`lessons: ${lessons.length}`);
  console.log(`video ids (in order):\n${JSON.stringify(lessons.map((l) => l.id))}`);
  console.log(`\nResult journal: ${RESULT_FILE}`);
}

main().catch((e) => { console.error('\nINGEST FAILED:', e.message); process.exit(1); });

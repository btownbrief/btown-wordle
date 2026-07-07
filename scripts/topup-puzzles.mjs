#!/usr/bin/env node
// B-Town Wordle schedule top-up.
//
// Keeps data/puzzles.json at least MIN_AHEAD days ahead of today
// (America/New_York). When the runway is short it fetches recent Btown Brief
// editions from RSS for topical seed material, then asks Claude for a batch
// of new local answers (4–7 letters) with "why it's local" blurbs. Every
// candidate is validated hard; invalid or repeat answers are dropped. If the
// whole batch fails, the file is left untouched and the run fails loudly.
//
// No dependencies — plain Node 18+. Run manually:  node scripts/topup-puzzles.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'puzzles.json');
const FEED = 'https://rss.beehiiv.com/feeds/1BT4mvZXMo.xml';
const MODEL = 'claude-sonnet-5';
const MIN_AHEAD = Number(process.env.MIN_AHEAD || 90); // top up when fewer future days remain
const BATCH = 30;       // days added per run

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('ANTHROPIC_API_KEY is not set'); process.exit(1); }

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const dates = Object.keys(data.puzzles).sort();
const lastDate = dates[dates.length - 1];
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const daysAhead = Math.round((Date.parse(lastDate) - Date.parse(today)) / 86400000);
console.log(`Schedule runs through ${lastDate} (${daysAhead} days ahead).`);
if (daysAhead >= MIN_AHEAD) { console.log('Nothing to do.'); process.exit(0); }

// ---------------------------------------------------------------- RSS seed
const strip = (s) => s
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/\s+/g, ' ').trim();

let newsletterText = '';
try {
  const xml = await (await fetch(FEED, { headers: { 'user-agent': 'btown-wordle-topup' } })).text();
  const items = xml.split('<item>').slice(1, 5); // 4 most recent editions
  newsletterText = items.map((it) => {
    const title = strip((it.match(/<title>([\s\S]*?)<\/title>/) || [, ''])[1]);
    const link = strip((it.match(/<link>([\s\S]*?)<\/link>/) || [, ''])[1]);
    let body = (it.match(/content:encoded>([\s\S]*?)<\/content:encoded>/) || [, ''])[1];
    body = strip(body.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')).slice(0, 4000);
    return `EDITION: ${title}\nURL: ${link}\n${body}`;
  }).join('\n\n---\n\n');
} catch (e) {
  console.error(`RSS fetch failed (${e.message}) — generating without newsletter seed.`);
}

// ---------------------------------------------------------------- Claude
const used = [...new Set(Object.values(data.puzzles).map((p) => p.answer.toUpperCase()))];

const prompt = `You are the puzzle editor for B-Town Wordle, the daily word game of the Btown Brief, a Burlington, Vermont newsletter. Every answer must be LOCAL: a Burlington street or place, a Vermont town, food, business, person, institution, or Vermont-ism. Answers must be real, verifiable local terms a Burlington-area reader would recognize — never invented, never generic English words without a genuine local angle.

Produce ${BATCH} NEW puzzle entries as a JSON array. Each entry:
{"answer": "4-7 uppercase A-Z letters, single word, no spaces/punctuation", "whyLocal": "1-2 informative sentences on its Burlington/Vermont significance", "sourceUrl": "optional — ONLY if the entry comes directly from one of the newsletter editions below, use that edition's URL"}

HARD RULES:
- answer length 4-7, letters A-Z only
- NEVER reuse any of these already-used answers: ${used.join(', ')}
- no two entries in your batch may share an answer
- whyLocal must be specific and factual; if unsure of a fact, pick a different answer
- prefer a mix of lengths and categories; a few answers seeded from the recent newsletter content below are great

RECENT NEWSLETTER CONTENT (for topical seeds):
${newsletterText || '(unavailable this week — use evergreen local answers)'}

Reply with ONLY the JSON array, no markdown fences, no commentary.`;

const res = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'x-api-key': API_KEY,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    model: MODEL,
    max_tokens: 16000,
    messages: [{ role: 'user', content: prompt }],
  }),
});
if (!res.ok) {
  console.error(`Claude API error: HTTP ${res.status} — ${await res.text()}`);
  process.exit(1);
}
const msg = await res.json();
let text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
text = text.trim().replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');

let batch;
try {
  batch = JSON.parse(text);
  if (!Array.isArray(batch)) throw new Error('not an array');
} catch (e) {
  // response may have been truncated mid-entry — salvage the complete objects
  const cut = text.lastIndexOf('},');
  try {
    batch = JSON.parse(text.slice(0, cut + 1) + ']');
    console.log(`Recovered ${batch.length} entries from truncated output (stop: ${msg.stop_reason}).`);
  } catch {
    console.error(`Could not parse Claude output as JSON array: ${e.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- validate hard
const usedSet = new Set(used);
const accepted = [];
for (const entry of batch) {
  const answer = String(entry?.answer || '').toUpperCase().trim();
  const whyLocal = String(entry?.whyLocal || '').trim();
  const sourceUrl = typeof entry?.sourceUrl === 'string' && /^https?:\/\//.test(entry.sourceUrl)
    ? entry.sourceUrl : undefined;
  if (!/^[A-Z]{4,7}$/.test(answer)) { console.log(`drop (bad answer): ${answer}`); continue; }
  if (usedSet.has(answer)) { console.log(`drop (repeat): ${answer}`); continue; }
  if (whyLocal.length < 30) { console.log(`drop (weak whyLocal): ${answer}`); continue; }
  usedSet.add(answer);
  accepted.push(sourceUrl ? { answer, whyLocal, sourceUrl } : { answer, whyLocal });
}
console.log(`Accepted ${accepted.length}/${batch.length} entries.`);
if (accepted.length === 0) {
  console.error('Entire batch failed validation — committing nothing.');
  process.exit(1);
}

// append after the last scheduled date
let cursor = Date.parse(lastDate + 'T12:00:00Z');
for (const entry of accepted) {
  cursor += 86400000;
  data.puzzles[new Date(cursor).toISOString().slice(0, 10)] = entry;
}
writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
console.log(`Added ${accepted.length} days; schedule now runs through ${new Date(cursor).toISOString().slice(0, 10)}.`);

#!/usr/bin/env node
/**
 * Builds the app's own station catalog.
 *
 *   node catalog/build.mjs                 full build into catalog/site/
 *   node catalog/build.mjs --no-check      skip the stream checks (fast, for trying things out)
 *   node catalog/build.mjs --input file    use a saved directory export instead of downloading
 *
 * Steps: fetch the Radio Browser export → drop removals → apply corrections → add our own
 * stations → check streams (ours, the popular ones, and last night's failures) → write
 * site/stations.json, site/meta.json and site/checks.json (the check history, read back next run
 * from the published site so a station is only dropped after three failures in a row).
 *
 * Plain Node 20+, no packages.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
const SITE = join(HERE, 'site');
const USER_AGENT = 'AirwaveAtlasCatalog/1.0';
const FORMAT = 1;

/** Where the finished site lives; last night's check history is read from here. */
const SITE_URL = process.env.CATALOG_SITE_URL || '';
/** How many stations to test per run besides our own and last night's failures. */
const POPULAR_TO_CHECK = Number(process.env.CATALOG_CHECK_POPULAR || 2500);
/** A station is dropped once it has failed this many runs in a row. */
const STRIKES = 3;
const CHECK_TIMEOUT_MS = 8000;
const CHECK_CONCURRENCY = 40;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);
const readJson = (path, fallback) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback);
const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

// ------------------------------------------------------------------ fetching the export

async function fetchJson(url, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function mirrors() {
  try {
    const list = await fetchJson('https://all.api.radio-browser.info/json/servers', 15000);
    const names = [...new Set(list.map((s) => s.name).filter((n) => typeof n === 'string' && n.endsWith('radio-browser.info')))];
    if (names.length) return names.sort(() => Math.random() - 0.5);
  } catch (e) {
    log('mirror discovery failed:', e.message);
  }
  return ['de1.api.radio-browser.info', 'de2.api.radio-browser.info', 'fi1.api.radio-browser.info', 'nl1.api.radio-browser.info', 'at1.api.radio-browser.info'];
}

async function fetchExport() {
  const input = option('--input');
  if (input) {
    log('reading export from', input);
    return JSON.parse(readFileSync(input, 'utf8'));
  }
  // The directory hands out at most a few thousand stations per request, so page through it.
  const PAGE = 5000;
  let lastError;
  for (const host of await mirrors()) {
    try {
      log('downloading export from', host);
      const all = [];
      for (let offset = 0; ; offset += PAGE) {
        const page = await fetchJson(`https://${host}/json/stations?hidebroken=true&order=stationuuid&limit=${PAGE}&offset=${offset}`);
        if (!Array.isArray(page)) throw new Error(`unexpected answer at offset ${offset}`);
        all.push(...page);
        if (page.length < PAGE) break;
        if (all.length % 20000 === 0) log(`  …${all.length}`);
      }
      if (all.length < 1000) throw new Error(`export too small (${all.length})`);
      return all;
    } catch (e) {
      lastError = e;
      log('failed:', e.message);
    }
  }
  throw lastError ?? new Error('no mirror answered');
}

// ------------------------------------------------------------------ shaping stations

/** The directory record → the compact row the app reads. Null for unusable entries. */
function toRow(r) {
  const url = String(r.url_resolved || r.url || '').trim();
  const name = String(r.name || '').replace(/\s+/g, ' ').trim();
  if (!r.stationuuid || !url || !name || !/^https?:\/\//i.test(url)) return null;
  const tags = String(r.tags || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 1 && t.length < 28)
    .slice(0, 8);
  return {
    id: String(r.stationuuid),
    name,
    url,
    homepage: String(r.homepage || '').trim(),
    favicon: String(r.favicon || '').trim(),
    tags,
    countryCode: String(r.countrycode || '').toUpperCase().slice(0, 2),
    state: String(r.state || '').trim(),
    language: String(r.language || '').split(',')[0]?.trim() ?? '',
    codec: String(r.codec || '').trim(),
    bitrate: Number(r.bitrate) || 0,
    hls: Number(r.hls) === 1,
    votes: Number(r.votes) || 0,
    clicks: Number(r.clickcount) || 0,
  };
}

/** The directory holds many duplicate entries; keep the first of each name + stream. */
function dedupe(rows) {
  const seen = new Set();
  const out = [];
  for (const s of rows) {
    const key = `${s.name.toLowerCase()}|${s.url.replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase()}`;
    if (seen.has(s.id) || seen.has(key)) continue;
    seen.add(s.id);
    seen.add(key);
    out.push(s);
  }
  return out;
}

function applyRemovals(rows, removals) {
  const ids = new Set(removals.ids ?? []);
  const names = new Set((removals.names ?? []).map(norm));
  const patterns = (removals.patterns ?? []).map((p) => new RegExp(p, 'i'));
  let dropped = 0;
  const out = rows.filter((s) => {
    const gone = ids.has(s.id) || names.has(norm(s.name)) || patterns.some((p) => p.test(s.name));
    if (gone) dropped++;
    return !gone;
  });
  log(`removals: ${dropped} station(s) left out`);
  return out;
}

/** Places with no real broadcasters: stations filed there are someone's joke or a mistake, so they get no country. */
const NOT_A_COUNTRY = new Set(['AQ', 'BV', 'HM']);

function clearFakeCountries(rows) {
  let n = 0;
  for (const s of rows) if (NOT_A_COUNTRY.has(s.countryCode)) { s.countryCode = ''; s.state = ''; n++; }
  log(`not-a-country: ${n} station(s) left without a country`);
}

/**
 * Stations with no place, whose name says one ("Radio One - Tirana 95.2"): the place is taken from
 * the name when it is a place other stations of the same country are already filed under.
 */
function placesFromNames(rows) {
  const byCountry = new Map();
  for (const s of rows) {
    if (!s.state || !s.countryCode) continue;
    const key = norm(s.state);
    if (key.length < 4) continue;
    let m = byCountry.get(s.countryCode);
    if (!m) byCountry.set(s.countryCode, (m = new Map()));
    const e = m.get(key) ?? { count: 0, spellings: new Map() };
    e.count++;
    e.spellings.set(s.state, (e.spellings.get(s.state) ?? 0) + 1);
    m.set(key, e);
  }
  let n = 0;
  for (const s of rows) {
    if (s.state || !s.countryCode) continue;
    const places = byCountry.get(s.countryCode);
    if (!places) continue;
    const name = ` ${norm(s.name)} `;
    let best = null;
    for (const [key, e] of places) {
      if (e.count < 2 || !name.includes(` ${key} `)) continue;
      if (!best || key.length > best.key.length) best = { key, e };
    }
    if (!best) continue;
    s.state = [...best.e.spellings].sort((a, b) => b[1] - a[1])[0][0];
    n++;
  }
  log(`places from names: ${n} station(s) given a place`);
}

function applyCorrections(rows, corrections) {
  const byName = new Map((corrections.stations ?? []).map((c) => [norm(c.name), c]));
  let fixed = 0;
  const seen = [];
  for (const s of rows) {
    const key = norm(s.name);
    const fix = byName.get(key) ?? [...byName.values()].find((c) => key.startsWith(`${norm(c.name)} `));
    if (!fix) continue;
    // `onlyIn`: apply only to stations the directory files under this country (names can repeat across countries).
    if (fix.onlyIn && String(fix.onlyIn).toUpperCase() !== s.countryCode) continue;
    const country = String(fix.country || s.countryCode).toUpperCase();
    s.state = fix.state ?? (country === s.countryCode ? s.state : '');
    s.countryCode = country;
    // `addTags`: genres to add, so the station shows under those genre buttons.
    for (const t of fix.addTags ?? []) {
      const tag = String(t).trim().toLowerCase();
      if (tag && !s.tags.includes(tag)) s.tags = [...s.tags, tag];
    }
    seen.push(`${s.name} (${s.countryCode}${s.state ? ', ' + s.state : ''})`);
    fixed++;
  }
  log(`corrections: ${fixed} station(s) re-filed`);
  // Shown on the run's page in GitHub, so it is easy to see which stations a correction caught.
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Corrections::${seen.join('; ').slice(0, 900) || 'none matched'}`);
}

function ourStations(additions) {
  const out = [];
  for (const a of additions.stations ?? []) {
    if (a.skip) continue;
    const url = String(a.url || '').trim();
    const name = String(a.name || '').trim();
    const country = String(a.country || '').toUpperCase();
    if (!url || !name || !/^[A-Z]{2}$/.test(country) || !/^https?:\/\//i.test(url)) {
      log(`additions: skipping "${name || url}" (needs name, url and a two-letter country)`);
      continue;
    }
    out.push({
      id: `own-${createHash('sha1').update(url.toLowerCase()).digest('hex').slice(0, 20)}`,
      name,
      url,
      homepage: String(a.homepage || '').trim(),
      favicon: String(a.favicon || '').trim(),
      tags: (a.tags ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 8),
      countryCode: country,
      state: String(a.state || '').trim(),
      language: String(a.language || '').trim(),
      codec: String(a.codec || '').trim().toUpperCase() || (/\.m3u8(\?|$)/i.test(url) ? 'AAC' : /\.aac(\?|$)/i.test(url) ? 'AAC' : 'MP3'),
      bitrate: Number(a.bitrate) || 0,
      hls: /\.m3u8(\?|$)/i.test(url),
      votes: 0,
      clicks: 0,
      own: true,
    });
  }
  log(`additions: ${out.length} station(s) of our own`);
  return out;
}

// ------------------------------------------------------------------ checking streams

/**
 * Does the stream answer? A short GET (we only need the headers and the first bytes); a 2xx with
 * an audio or playlist content type, or no content type at all, counts as working.
 */
async function streamAnswers(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Icy-MetaData': '0', Range: 'bytes=0-4095' }, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return false;
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const okType = !type || /audio|mpegurl|octet-stream|ogg|aac|mp3|mpeg|x-scpls|video\/mp2t|flv/.test(type);
    if (!okType) return false;
    // Read a little so a stalled connection fails here rather than later on the phone.
    const reader = res.body?.getReader();
    if (reader) {
      const chunk = await reader.read();
      reader.cancel().catch(() => {});
      return !chunk.done || type.includes('mpegurl');
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function checkStreams(rows, history) {
  const own = rows.filter((s) => s.own);
  const failing = rows.filter((s) => !s.own && history[s.id]?.fails > 0);
  const popular = [...rows].filter((s) => !s.own).sort((a, b) => b.clicks - a.clicks).slice(0, POPULAR_TO_CHECK);
  const toCheck = dedupe([...own, ...failing, ...popular]);
  log(`checking ${toCheck.length} stream(s): ${own.length} of ours, ${failing.length} failing last time, top ${POPULAR_TO_CHECK} by plays`);
  const now = new Date().toISOString();
  let i = 0;
  let okCount = 0;
  const worker = async () => {
    while (i < toCheck.length) {
      const s = toCheck[i++];
      const ok = await streamAnswers(s.url);
      const h = history[s.id] ?? { fails: 0 };
      if (ok) {
        okCount++;
        history[s.id] = { fails: 0, lastOk: now };
      } else {
        history[s.id] = { fails: h.fails + 1, lastOk: h.lastOk ?? null, lastFail: now };
      }
      if ((okCount + (i - okCount)) % 500 === 0) log(`  …${i}/${toCheck.length}`);
    }
  };
  await Promise.all(Array.from({ length: CHECK_CONCURRENCY }, worker));
  log(`checked: ${okCount} working, ${toCheck.length - okCount} not answering`);
  // Forget stations that are no longer in the export at all, so the history does not grow forever.
  const live = new Set(rows.map((s) => s.id));
  for (const id of Object.keys(history)) if (!live.has(id)) delete history[id];
}

// ------------------------------------------------------------------ main

async function main() {
  mkdirSync(SITE, { recursive: true });
  const additions = readJson(join(DATA, 'additions.json'), {});
  const removals = readJson(join(DATA, 'removals.json'), {});
  const corrections = readJson(join(DATA, 'corrections.json'), {});

  // Last night's check history: from the published site if we know where it is, else from disk.
  let history = {};
  if (SITE_URL) {
    try {
      history = await fetchJson(`${SITE_URL.replace(/\/$/, '')}/checks.json`, 30000);
      log(`check history: ${Object.keys(history).length} entries from the site`);
    } catch (e) {
      log('no check history on the site yet:', e.message);
    }
  }
  if (!Object.keys(history).length) history = readJson(join(SITE, 'checks.json'), {});

  const raw = await fetchExport();
  log(`export: ${raw.length} entries`);
  let rows = dedupe(raw.map(toRow).filter(Boolean));
  log(`usable: ${rows.length}`);
  rows = applyRemovals(rows, removals);
  clearFakeCountries(rows);
  applyCorrections(rows, corrections);
  placesFromNames(rows);
  const own = ourStations(additions);
  const ownUrls = new Set(own.map((s) => s.url.toLowerCase()));
  rows = [...own, ...rows.filter((s) => !ownUrls.has(s.url.toLowerCase()))];

  if (!flag('--no-check')) await checkStreams(rows, history);
  else log('stream checks skipped');

  // Directory stations get three strikes; our own additions must answer tonight to go in at all.
  const before = rows.length;
  const checked = !flag('--no-check');
  rows = rows.filter((s) => (s.own && checked ? (history[s.id]?.fails ?? 0) === 0 : (history[s.id]?.fails ?? 0) < STRIKES));
  log(`dropped ${before - rows.length} station(s): failed ${STRIKES} runs in a row, or one of ours that did not answer`);

  // Compact rows: one array per station, in a fixed column order the app knows.
  const columns = ['id', 'name', 'url', 'homepage', 'favicon', 'tags', 'countryCode', 'state', 'language', 'codec', 'bitrate', 'hls', 'votes', 'clicks', 'own'];
  const body = JSON.stringify({
    format: FORMAT,
    built: new Date().toISOString(),
    count: rows.length,
    columns,
    stations: rows.map((s) => columns.map((c) => (c === 'own' ? (s.own ? 1 : 0) : c === 'hls' ? (s.hls ? 1 : 0) : s[c]))),
  });
  writeFileSync(join(SITE, 'stations.json'), body);
  const sha = createHash('sha256').update(body).digest('hex');
  writeFileSync(join(SITE, 'meta.json'), JSON.stringify({ format: FORMAT, built: JSON.parse(body).built, count: rows.length, bytes: Buffer.byteLength(body), sha256: sha, own: own.length }, null, 2));
  writeFileSync(join(SITE, 'checks.json'), JSON.stringify(history));
  if (!existsSync(join(SITE, 'index.html'))) {
    writeFileSync(
      join(SITE, 'index.html'),
      `<!doctype html><meta charset="utf-8"><title>Airwave Atlas catalog</title><body style="font-family:system-ui;background:#0B0E2A;color:#F6F8FF;padding:2rem"><h1>Airwave Atlas station catalog</h1><p>Built nightly from the Radio Browser directory plus our own additions and corrections.</p><p><a style="color:#FFB830" href="meta.json">meta.json</a> · <a style="color:#FFB830" href="stations.json">stations.json</a></p>`,
    );
  }
  log(`wrote ${rows.length} stations, ${(Buffer.byteLength(body) / 1e6).toFixed(1)} MB, to ${SITE}`);
}

main().catch((e) => {
  console.error('build failed:', e);
  process.exit(1);
});

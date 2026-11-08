#!/usr/bin/env node
/**
 * Finds the stream address behind a radio station's website.
 *
 *   node catalog/find-streams.mjs                 every entry in catalog/data/wanted.json
 *   node catalog/find-streams.mjs --site URL      one site, print what it finds
 *   node catalog/find-streams.mjs --dead          directory stations whose stream failed (from site/checks.json)
 *
 * It opens the site in a hidden browser, presses play (looks for play buttons), watches every
 * request the page makes, and keeps the ones that look like audio or a playlist. Each candidate
 * is then tested like the nightly build does, and the working ones are written to
 * catalog/data/additions.json (new stations) or printed (repairs).
 *
 * Needs Playwright with Chromium, once:  npm i -D playwright  &&  npx playwright install chromium
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const WATCH_MS = 15000;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
const log = (...p) => console.log(new Date().toISOString().slice(11, 19), ...p);
const readJson = (path, fallback) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback);

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. In the catalog folder run:\n  npm i -D playwright\n  npx playwright install chromium');
  process.exit(1);
}

/** Does this request look like a radio stream or its playlist? */
function looksLikeStream(url, contentType) {
  const u = url.toLowerCase();
  if (/\.(png|jpe?g|gif|svg|webp|css|js|woff2?|ttf|ico|json|html?)(\?|$)/.test(u)) return false;
  if (/google|facebook|doubleclick|analytics|gstatic|yandex|mc\.yandex|hotjar|sentry/.test(u)) return false;
  // Single tracks, not stations.
  if (/preview|\/songs?\/|\/tracks?\/|podcast|jingle|promo|\/uploads?\/|\/storage\/|\/media\/|\/audio\/[^/]*\.mp3$/.test(u)) return false;
  const t = (contentType || '').toLowerCase();
  if (/audio\/|mpegurl|x-scpls|aacp?$|ogg|octet-stream/.test(t)) return true;
  return /\.(mp3|aac|aacp|m3u8|m3u|pls|ogg|opus)(\?|$)|\/stream|\/listen|\/live|:8[0-9]{3}\/|icecast|shoutcast|radiocast|streaming/.test(u);
}

/** A short GET: does the stream answer with audio (or a playlist)? Mirrors the nightly build. */
async function streamAnswers(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'AirwaveAtlasCatalog/1.0', 'Icy-MetaData': '0' }, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (type && !/audio|mpegurl|octet-stream|ogg|aac|mp3|mpeg|x-scpls|video\/mp2t/.test(type)) return null;
    // A live stream has no end: a file with a known length (a song, a jingle, a preview) is not a station.
    const length = Number(res.headers.get('content-length'));
    const icy = [...res.headers.keys()].some((k) => k.startsWith('icy-') || k.startsWith('ice-'));
    if (length > 0 && !icy && !type.includes('mpegurl')) return null;
    const reader = res.body?.getReader();
    if (reader) {
      const chunk = await reader.read();
      reader.cancel().catch(() => {});
      if (chunk.done && !type.includes('mpegurl')) return null;
    }
    const bitrate = Number(res.headers.get('icy-br')) || 0;
    const name = res.headers.get('icy-name') || '';
    const codec = type.includes('aac') ? 'AAC' : type.includes('mpegurl') ? 'HLS' : type.includes('ogg') ? 'OGG' : 'MP3';
    return { url, codec, bitrate, icyName: name };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Opens the site, presses play, and returns the stream-looking requests it saw, most promising first. */
async function sniff(browser, site) {
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-US', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const seen = new Map();
  const note = (url, type, how) => {
    if (!url.startsWith('http') || seen.has(url)) return;
    if (looksLikeStream(url, type)) seen.set(url, { url, type: type || '', how, at: Date.now() });
  };
  page.on('request', (r) => note(r.url(), '', 'request'));
  page.on('response', (r) => note(r.url(), r.headers()['content-type'], 'response'));
  // Audio elements set their source without a request we can see until play, so read them too.
  const readAudioTags = async () => {
    try {
      const srcs = await page.evaluate(() => {
        const out = [];
        for (const a of document.querySelectorAll('audio, video, source')) {
          const s = a.src || a.getAttribute('src') || a.getAttribute('data-src') || a.getAttribute('data-stream') || a.getAttribute('data-url');
          if (s) out.push(s);
        }
        for (const el of document.querySelectorAll('[data-stream], [data-src], [data-url], [data-file], [data-mp3]')) {
          for (const k of ['data-stream', 'data-src', 'data-url', 'data-file', 'data-mp3']) {
            const s = el.getAttribute(k);
            if (s) out.push(s);
          }
        }
        // Stream addresses embedded in the page's scripts and settings.
        // Scripts often write addresses as http:\/\/host\/path; undo that first.
        const html = document.documentElement.innerHTML.replace(/\\\//g, '/');
        const re = /https?:\/\/[^\s"'<>\\]+?(?:\.(?:mp3|aac|aacp|m3u8|m3u|pls|ogg)|\/stream[^\s"'<>\\]*|:8\d{3}\/[^\s"'<>\\]*)/gi;
        for (const m of html.matchAll(re)) out.push(m[0]);
        return out;
      });
      for (const s of srcs) note(s.replace(/\\\//g, '/'), '', 'page');
    } catch {}
  };
  try {
    await page.goto(site, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    await readAudioTags();
    // Press anything that looks like a play button, including inside frames.
    const selectors = [
      'button[aria-label*="play" i]',
      'button[title*="play" i]',
      '[class*="play" i]:not([class*="player" i]):not([class*="playlist" i])',
      '[id*="play" i]:not([id*="player" i])',
      'button:has-text("Play")',
      'a:has-text("Listen")',
      'button:has-text("Listen")',
      'button:has-text("Слушать")',
      'a:has-text("Слушать")',
      'button:has-text("Тыңдау")',
      '.jp-play, .plyr__control, .mejs__playpause-button, .vjs-big-play-button, .radio-play, .play-btn, .btn-play',
    ];
    for (const frame of page.frames()) {
      for (const sel of selectors) {
        try {
          const el = frame.locator(sel).first();
          if ((await el.count()) && (await el.isVisible({ timeout: 300 }))) {
            await el.click({ timeout: 2000, force: true });
            await page.waitForTimeout(1200);
          }
        } catch {}
      }
    }
    // Then wait for the player to start and watch what it loads.
    const started = Date.now();
    while (Date.now() - started < WATCH_MS) {
      await page.waitForTimeout(1500);
      await readAudioTags();
      if ([...seen.values()].some((s) => /audio|mpegurl/.test(s.type))) break;
    }
  } catch (e) {
    log(`  could not open ${site}: ${e.message.split('\n')[0]}`);
  } finally {
    await context.close();
  }
  // Responses with an audio type first, then playlists, then anything that merely looked right.
  return [...seen.values()].sort((a, b) => score(b) - score(a)).map((s) => s.url);
}

function score(s) {
  let v = 0;
  if (/audio\//.test(s.type)) v += 10;
  if (/mpegurl/.test(s.type) || /\.m3u8/.test(s.url)) v += 8;
  if (/\.(mp3|aac|aacp)(\?|$)/.test(s.url)) v += 6;
  if (/\/stream|\/listen|\/live|:8\d{3}\//.test(s.url)) v += 3;
  if (s.how === 'page') v += 1;
  return v;
}

/** Directory and social sites: never a station's own site. */
const NOT_OFFICIAL = /onlineradiobox|mytuner|streema|radio\.net|radio-browser|radiohear|dubbeh|topradio|radio-online|radiovolna|radio-volna|online-radio-list|lixty|zeno\.fm|tunein|liveonlineradio|radioinc|bestradio|oiradio|facebook|instagram|vk\.com|youtube|wikipedia|wikiwand|apple\.com|google|yandex|duckduckgo|bing\.com|2gis|kaspi|olx|tiktok|t\.me|telegram/i;

/** Looks the station up on DuckDuckGo and returns candidate websites, most likely first. */
async function findSites(page, name, country) {
  const query = `${name} radio ${country === 'KZ' ? 'Казахстан' : country} официальный сайт`;
  const out = [];
  try {
    await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const links = await page.evaluate(() => [...document.querySelectorAll('a.result__a, a.result__url, h2 a')].map((a) => a.href));
    for (let href of links) {
      try {
        const u = new URL(href);
        // DuckDuckGo wraps results in a redirect with the real address in `uddg`.
        const real = u.searchParams.get('uddg');
        if (real) href = real;
        const host = new URL(href).hostname;
        if (NOT_OFFICIAL.test(href) || out.some((o) => new URL(o).hostname === host)) continue;
        out.push(new URL(href).origin + '/');
      } catch {}
      if (out.length >= 3) break;
    }
  } catch (e) {
    log(`  search failed: ${e.message.split('\n')[0]}`);
  }
  return out;
}

/** Best working stream for one site, or null. */
async function findStream(browser, site) {
  const candidates = await sniff(browser, site);
  log(`  ${candidates.length} candidate(s)`);
  for (const url of candidates.slice(0, 8)) {
    const ok = await streamAnswers(url);
    if (ok) return ok;
  }
  return null;
}

async function main() {
  const browser = await chromium.launch();
  try {
    if (option('--site')) {
      const site = option('--site');
      log('looking at', site);
      const found = await findStream(browser, site);
      console.log(found ? `\nStream: ${found.url}\nFormat: ${found.codec}${found.bitrate ? ` ${found.bitrate} kbps` : ''}${found.icyName ? `\nName from stream: ${found.icyName}` : ''}` : '\nNo working stream found on that page.');
      return;
    }
    if (flag('--dead')) {
      // Directory stations that failed last night: try their homepages for a new address.
      const checks = readJson(join(HERE, 'site', 'checks.json'), {});
      const stations = readJson(join(HERE, 'site', 'stations.json'), null);
      if (!stations) {
        console.error('Run build.mjs first so site/stations.json and site/checks.json exist.');
        return;
      }
      const col = (n) => stations.columns.indexOf(n);
      const dead = stations.stations.filter((r) => (checks[r[col('id')]]?.fails ?? 0) > 0 && r[col('homepage')]).slice(0, Number(option('--limit') || 25));
      log(`${dead.length} failing station(s) with a website`);
      const repairs = [];
      for (const r of dead) {
        const name = r[col('name')];
        log(`${name}: ${r[col('homepage')]}`);
        const found = await findStream(browser, r[col('homepage')]);
        if (found && found.url !== r[col('url')]) {
          repairs.push({ name, old: r[col('url')], url: found.url, country: r[col('countryCode')] });
          log(`  → ${found.url}`);
        } else log('  nothing new');
      }
      writeFileSync(join(DATA, 'repairs.json'), JSON.stringify({ _help: 'New addresses found for failing directory stations. Review, then submit them at radio-browser.info or copy into additions.json.', found: repairs }, null, 2));
      log(`wrote ${repairs.length} repair(s) to data/repairs.json`);
      return;
    }
    // Default: the wanted list → additions.json
    const wanted = readJson(join(DATA, 'wanted.json'), { stations: [] });
    const additionsPath = join(DATA, 'additions.json');
    const additions = readJson(additionsPath, { stations: [] });
    const have = new Set(additions.stations.map((s) => (s.url || '').toLowerCase()));
    let added = 0;
    const searchContext = await browser.newContext({ userAgent: USER_AGENT, locale: 'ru-RU' });
    const searchPage = await searchContext.newPage();
    for (const w of wanted.stations ?? []) {
      if (!w.name || !w.country) {
        log(`skipping "${w.name || '?'}": needs name and country`);
        continue;
      }
      if (w.done) continue;
      // No website given: look it up, and try the first few results that are not directories.
      let sites = w.site ? [w.site] : [];
      if (!sites.length) {
        sites = await findSites(searchPage, w.name, w.country);
        log(`${w.name}: looked up → ${sites.join(', ') || 'no sites found'}`);
      } else log(`${w.name}: ${w.site}`);
      let found = null;
      for (const site of sites) {
        found = await findStream(browser, site);
        if (found) {
          w.site = site;
          break;
        }
      }
      if (!found) {
        log('  nothing working found');
        continue;
      }
      log(`  → ${found.url} (${found.codec}${found.bitrate ? ` ${found.bitrate} kbps` : ''})`);
      if (!have.has(found.url.toLowerCase())) {
        additions.stations.push({
          name: w.name,
          url: found.url,
          homepage: w.site,
          favicon: w.favicon || '',
          country: w.country,
          state: w.state || '',
          tags: w.tags || [],
          language: w.language || '',
          codec: found.codec === 'HLS' ? 'AAC' : found.codec,
          bitrate: found.bitrate,
        });
        have.add(found.url.toLowerCase());
        added++;
      }
      w.done = true;
    }
    await searchContext.close();
    writeFileSync(additionsPath, JSON.stringify(additions, null, 2));
    writeFileSync(join(DATA, 'wanted.json'), JSON.stringify(wanted, null, 2));
    log(`added ${added} station(s) to data/additions.json`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('find-streams failed:', e);
  process.exit(1);
});

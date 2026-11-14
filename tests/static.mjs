// Checks that need no browser: the page's search and link-preview metadata, version strings in
// step, nothing in index.html that radmagelabs.com's Content-Security-Policy would block, and no
// em or en dashes in the repository's text (house style).
//
//   node tests/static.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reporter } from './lib/chrome.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const CANONICAL = 'https://radmagelabs.com/delta/';

export function run() {
  const rep = reporter('static');
  const check = rep.check;
  const html = read('delta/index.html');
  const meta = (attr, key) => { const m = html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`)); return m ? decode(m[1]) : null; };

  // Metadata (the rules tools/verify-live.mjs in the RadMage Labs site applies).
  const title = decode((html.match(/<title>([^<]*)<\/title>/) || [])[1] || '');
  check('title present and no longer than 65 characters', title.length > 0 && title.length <= 65, `${title.length}: ${title}`);
  check('title names Delta and ends with the site name', /^Delta v\d+\.\d+ - /.test(title) && title.endsWith(' | RadMage Labs'), title);
  const desc = meta('name', 'description');
  check('meta description 70 to 160 characters', desc && desc.length >= 70 && desc.length <= 160, `${desc && desc.length}`);
  check('one canonical link, to radmagelabs.com/delta/', (html.match(/rel="canonical"/g) || []).length === 1 && html.includes(`<link rel="canonical" href="${CANONICAL}">`));
  check('og:url is the canonical address', meta('property', 'og:url') === CANONICAL);
  for (const k of ['og:title', 'og:description', 'og:image:alt']) check(`${k} present`, Boolean(meta('property', k)));
  check('og:image is the Labs preview image, 1200 x 630', meta('property', 'og:image') === 'https://radmagelabs.com/assets/og/delta.png' && meta('property', 'og:image:width') === '1200' && meta('property', 'og:image:height') === '630');
  check('twitter:card present', meta('name', 'twitter:card') === 'summary_large_image');
  const ldRaw = (html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [])[1];
  let ld = null; try { ld = JSON.parse(ldRaw); } catch {}
  check('JSON-LD parses', Boolean(ld));
  if (ld) {
    check('JSON-LD url is the canonical address', ld.url === CANONICAL);
    check('JSON-LD description equals the meta description', ld.description === desc, `${ld.description} | ${desc}`);
    check('JSON-LD has no version (it would drift)', !('softwareVersion' in ld));
  }

  // Version strings in step.
  const v = (title.match(/^Delta (v\d+\.\d+)/) || [])[1];
  const readme = read('README.md'), changelog = read('CHANGELOG.md');
  const found = {
    title: v,
    tagline: (html.match(/<span class="tagline">(v\d+\.\d+) /) || [])[1],
    about: (html.match(/id="about-dialog-title">delta (v\d+\.\d+)_</) || [])[1],
    readmeHeading: (readme.match(/^# Delta (v\d+\.\d+)$/m) || [])[1],
    readmeRelease: (readme.match(/The current release is \*\*(v\d+\.\d+)\*\*/) || [])[1],
    changelog: (changelog.match(/^## (v\d+\.\d+) - /m) || [])[1],
  };
  check('version the same in title, tagline, About, README and CHANGELOG', v && Object.values(found).every((x) => x === v), JSON.stringify(found));

  // Nothing the radmagelabs.com policy (script-src 'self', no 'unsafe-inline') would block.
  const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].filter((m) => !/type="application\/ld\+json"/.test(m[1]));
  check('no inline scripts (only JSON-LD data)', inlineScripts.length === 0, `${inlineScripts.length}`);
  check('no inline event-handler attributes', !/<[a-z][^>]*\son[a-z]+\s*=/i.test(html));
  check('no javascript: URLs', !/javascript:/i.test(html));
  check('scripts load only from this folder', [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].every((m) => !/^[a-z]+:|^\/\//i.test(m[1])));

  // House style: no em or en dashes anywhere in the repository's text.
  // Built from code points so this file itself contains no dash characters.
  const DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
  const files = [];
  const walk = (d) => { for (const n of readdirSync(join(ROOT, d))) { if (n === '.git' || n === 'node_modules') continue; const p = d ? `${d}/${n}` : n; if (statSync(join(ROOT, p)).isDirectory()) walk(p); else if (/\.(html|css|js|mjs|md|yml|txt|json)$|^LICENSE$|\.gitignore$/.test(n)) files.push(p); } };
  walk('');
  const dashed = files.filter((f) => DASHES.test(read(f)));
  check('no em or en dashes in any text file', dashed.length === 0, dashed.join(', '));
  return { results: rep.results };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { results } = run();
  for (const r of results.filter((x) => !x.ok)) console.log(`FAIL ${r.name}  ${r.detail}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`static: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

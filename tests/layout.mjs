// Layout checks at phone, tablet and desktop widths.
//
//   node tests/layout.mjs <delta-url> [--out DIR]
//
// At 320, 375, 390, 768, 1024 and 1440 px it loads Delta, puts it in several states (the switch
// comparison, Unified view, Preview with long URLs and code, Base / 3-way with the merge panel, a
// saved tab, Folder Compare before and after comparing two fixture folders, the About dialog,
// and lines with long unbroken text) and checks:
// - nothing makes the page wider than the screen (phones are emulated as phones, where Chrome
//   would otherwise widen the layout viewport to fit and zoom the page out);
// - every visible control lies within the screen, or inside a scrolling strip that does;
// - on touch widths, every control is at least 24 x 24 CSS px (WCAG 2.2 target size), counting
//   only its own box (inline links inside text are exempt, as WCAG allows);
// - the About dialog fits the screen.
// Screenshots (first screen and whole page) go to --out when given.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch, reporter, sleep } from './lib/chrome.mjs';
import { SWITCH, click, compareFixtureFolders, setPair, shareHash } from './lib/delta.mjs';

export const WIDTHS = [
  { w: 320, h: 640, mobile: true },
  { w: 375, h: 812, mobile: true },
  { w: 390, h: 844, mobile: true },
  { w: 768, h: 1024, mobile: true },
  { w: 1024, h: 768, mobile: false },
  { w: 1440, h: 900, mobile: false },
];

// Runs in the page: what sticks out past W, which controls can't be reached, and small targets.
const MEASURE = (W) => `
  const W = ${W};
  const visible = (el) => { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const name = (el) => el.id ? '#' + el.id : el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/)[0] : '') + (el.textContent && el.textContent.trim() ? '"' + el.textContent.trim().replace(/\\s+/g, ' ').slice(0, 18) + '"' : '');
  // An ancestor that scrolls sideways and itself fits: what it holds is reachable by scrolling it.
  const scroller = (el) => { for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) { const cs = getComputedStyle(p); if (/(auto|scroll|hidden|clip)/.test(cs.overflowX)) return p; } return null; };
  const within = (r) => r.left >= -0.5 && r.right <= W + 0.5;
  const sticking = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || el.closest('dialog:not([open])')) continue;
    const r = el.getBoundingClientRect();
    if (within(r)) continue;
    const s = scroller(el); if (s && within(s.getBoundingClientRect())) continue;
    if (!sticking.some((x) => x.el.contains(el))) sticking.push({ el, right: Math.round(r.right) });
  }
  const controls = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => visible(el) && !el.closest('dialog:not([open])') && !el.disabled);
  const unreachable = controls.filter((el) => { const r = el.getBoundingClientRect(); if (within(r)) return false; const s = scroller(el); return !(s && within(s.getBoundingClientRect())); }).map(name);
  // Inline links in running text are exempt from the target size rule.
  const inline = (el) => el.tagName === 'A' && getComputedStyle(el).display === 'inline' && /\\S/.test((el.parentElement.textContent || '').replace(el.textContent, ''));
  const small = controls.filter((el) => !inline(el) && el.type !== 'file').map((el) => { const r = el.getBoundingClientRect(); return { n: name(el), w: Math.round(r.width), h: Math.round(r.height) }; }).filter((t) => t.w < 24 || t.h < 24);
  return { scrollWidth: document.documentElement.scrollWidth, sticking: sticking.map((x) => name(x.el) + ' to ' + x.right), unreachable, small, controls: controls.length };`;

const LONG_URL = 'https://example.com/a/very/long/path/that/keeps/going/without/any/spaces/at/all/so/it/cannot/wrap/normally/index_with_underscores.html?query=1&and=2';
const LONG_WORD = 'x'.repeat(220);
const PREVIEW_MD = `# Long content\n\nA link: [${LONG_URL}](${LONG_URL})\n\nA bare address ${LONG_URL} in a sentence.\n\nInline \`${LONG_WORD}\` code.\n\n\`\`\`\n${LONG_WORD}\n\`\`\`\n`;
const PREVIEW_HTML = `<div><p>${LONG_WORD}</p><table><tr><td>${'cell '.repeat(40)}</td></tr></table><pre>${LONG_WORD}</pre></div>`;

export async function run(url, { out = null, label = 'layout' } = {}) {
  const rep = reporter(label);
  const summary = [];
  if (out) mkdirSync(out, { recursive: true });
  for (const { w, h, mobile } of WIDTHS) {
    const b = await launch({ width: w, height: h, mobile, touch: mobile });
    const shot = async (name, full = false) => {
      if (!out) return;
      let opts = {};
      if (full) {
        const m = await b.send('Page.getLayoutMetrics');
        opts = { captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: Math.min(Math.ceil(m.cssContentSize.height), 12000), scale: 1 } };
      }
      writeFileSync(join(out, `${w}-${name}.png`), await b.screenshot(opts));
    };
    const measure = async (state) => {
      const m = await b.eval(MEASURE(w));
      const tag = `${w}px ${state}`;
      rep.check(`${tag}: page no wider than the screen`, m.scrollWidth <= w, `scrollWidth ${m.scrollWidth}; sticking out: ${m.sticking.slice(0, 6).join(', ')}`);
      rep.check(`${tag}: every control within reach`, m.unreachable.length === 0, m.unreachable.slice(0, 8).join(', '));
      if (mobile) rep.check(`${tag}: touch targets at least 24 x 24`, m.small.length === 0, m.small.slice(0, 10).map((t) => `${t.n} ${t.w}x${t.h}`).join(', '));
      summary.push({ w, state, scrollWidth: m.scrollWidth, small: m.small.length, unreachable: m.unreachable.length });
      return m;
    };

    // The switch comparison, the way a share link opens it.
    await b.goto(url + shareHash({ textA: SWITCH.before, textB: SWITCH.after, labelA: SWITCH.labelA, labelB: SWITCH.labelB }), { settle: 2600 });
    await measure('comparison');
    await shot('first-screen');
    await shot('full', true);
    // The textareas must stay usable: full width of their column and a sensible height.
    const ta = await b.eval(`const r = document.getElementById('text-a').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), font: parseFloat(getComputedStyle(document.getElementById('text-a')).fontSize) }`);
    rep.check(`${w}px: editor at least 85% of the screen width on phones, or a desktop column`, mobile && w < 700 ? ta.w >= w * 0.85 - 40 : ta.w >= 280, `${ta.w}px wide`);
    if (mobile && w < 700) rep.check(`${w}px: editor text at least 16px on touch screens (no zoom on focus)`, ta.font >= 16, `${ta.font}px`);
    rep.check(`${w}px: editor no taller than the screen on phones`, !(mobile && w < 700) || ta.h <= h, `${ta.h}px tall, screen ${h}`);

    await b.eval(`document.querySelector('[data-view="unified"]').click(); return 1`); await sleep(400);
    await measure('unified');
    await b.eval(`document.querySelector('[data-view="split"]').click(); return 1`); await sleep(300);

    // Long unbroken text in the diff itself.
    await setPair(b, `short\n${LONG_URL}\n${LONG_WORD}\nend`, `short\n${LONG_URL}&changed=3\n${LONG_WORD}y\nend`);
    await measure('long lines');

    // Previews with long URLs, long code and a wide HTML table.
    await setPair(b, PREVIEW_MD, PREVIEW_HTML, { compare: false });
    await click(b, 'opt-preview', 800);
    await measure('preview');
    await shot('preview');
    await click(b, 'opt-preview');

    // Base / 3-way with a conflict, which shows the merge panel.
    await click(b, 'base-toggle');
    await b.eval(`const t = document.getElementById('text-base'); t.value = 'one\\ntwo\\nthree\\n'; t.dispatchEvent(new Event('input', { bubbles: true })); return 1`);
    await setPair(b, 'one\ntwo A\nthree\n', 'one\ntwo B\nthree\n');
    await measure('3-way merge');
    await shot('merge', true);
    await click(b, 'base-toggle');

    // A saved tab in the tab strip, and an ignore pattern as a removable chip.
    await setPair(b, SWITCH.before, SWITCH.after);
    await click(b, 'save-button', 400);
    await b.eval(`const i = document.getElementById('ignore-pattern'); i.value = '^! Last configuration change'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await new Promise((r) => setTimeout(r, 300)); document.activeElement && document.activeElement.blur && document.activeElement.blur(); return document.querySelectorAll('.ignore-pattern-chip').length`);
    await measure('saved tab');

    // Folder Compare, before any folder is picked and then with results (long paths, an image
    // pair opened side by side).
    await b.eval(`document.querySelector('[data-app-mode="folder"]').click(); return 1`); await sleep(400);
    await measure('folder compare');
    await shot('folder');
    await compareFixtureFolders(b);
    await b.eval(`const row = [...document.querySelectorAll('.folder-diff-row')].find((r) => r.textContent.includes('rack_diagram')); row && row.click(); return 1`); await sleep(900);
    await measure('folder results');
    await shot('folder-results', true);
    await b.eval(`document.querySelector('[data-app-mode="text"]').click(); return 1`); await sleep(300);

    // The About dialog.
    await b.eval(`window.scrollTo(0, 0); document.getElementById('about-button').click(); return 1`); await sleep(400);
    const d = await b.eval(`const r = document.getElementById('about-dialog').getBoundingClientRect(); const f = document.querySelector('#about-dialog .modal-form'); return { open: document.getElementById('about-dialog').open, l: r.left, r: r.right, t: r.top, b: r.bottom, scrolls: f.scrollHeight > f.clientHeight }`);
    rep.check(`${w}px: About dialog opens inside the screen`, d.open && d.l >= 0 && d.r <= w && d.t >= 0 && d.b <= h, JSON.stringify(d));
    await measure('about dialog');
    await shot('about');
    await b.eval(`document.getElementById('about-close-button').click(); return 1`); await sleep(200);

    rep.check(`${w}px: no page errors`, b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
    rep.check(`${w}px: no requests to other sites`, b.outside.length === 0, b.outside.slice(0, 5).join(', '));
    await b.close();
  }
  return { results: rep.results, summary };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.argv[2];
  const oi = process.argv.indexOf('--out');
  const { results, summary } = await run(url, { out: oi > 0 ? process.argv[oi + 1] : null });
  for (const s of summary) console.log(`${String(s.w).padStart(5)}px ${s.state.padEnd(16)} scrollWidth ${String(s.scrollWidth).padStart(5)}  small targets ${s.small}  unreachable ${s.unreachable}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`layout: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

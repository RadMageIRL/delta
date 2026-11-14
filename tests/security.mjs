// The security regression suite (first written for v1.2): script injection through the diff
// view and both previews, requests that would leave the browser, the HTML preview's own policy,
// the server's policy when one is expected, and the two things the policy work touched (theme
// before first paint, share links).
//
//   node tests/security.mjs <delta-url> [--expect-csp]
//
// Every request to another site is caught by Fetch interception (tests/lib/chrome.mjs), recorded
// and failed, so "zero outside requests" means none was even attempted past the page's policy.
import { pathToFileURL } from 'node:url';
import { launch, reporter, sleep } from './lib/chrome.mjs';
import { click, setPair, shareHash } from './lib/delta.mjs';

const OUT = 'https://example.com/delta-probe';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export async function run(url, { expectCsp = false, label = 'security' } = {}) {
  const rep = reporter(label);
  const check = rep.check;
  const b = await launch({ width: 1400, height: 1000 });

  // Theme before first paint: a stored theme must be on <html> before app.js runs.
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__themeBeforeApp = null; new MutationObserver((m, o) => { if (document.querySelector('script[src="app.js"]')) { window.__themeBeforeApp = document.documentElement.getAttribute('data-theme') || 'none'; o.disconnect(); } }).observe(document, { childList: true, subtree: true });` });
  await b.goto(url);
  const boot = await b.eval(`return { title: document.title, csp: __csp.slice() }`);
  check('page loads', /^Delta v\d/.test(boot.title), boot.title);
  check('no policy violations at load', boot.csp.length === 0, JSON.stringify(boot.csp));
  await b.eval(`localStorage.setItem('delta_theme', 'vegas'); return 1`);
  await b.goto(url);
  check('stored theme applied before app.js runs', await b.eval('return window.__themeBeforeApp') === 'vegas');
  await b.eval(`localStorage.clear(); return 1`);

  // Share link: a comparison in the URL fragment loads into the panes.
  await b.goto('about:blank', { settle: 100 });
  await b.goto(url + shareHash({ textA: 'line one\nline two\n', textB: 'line one\nline 2\n', labelA: 'before', labelB: 'after' }), { settle: 1200 });
  const sh = await b.eval(`return { a: document.getElementById('text-a').value, lb: document.getElementById('label-b').value, csp: __csp.slice() }`);
  check('share link loads its comparison', sh.a === 'line one\nline two\n' && sh.lb === 'after', JSON.stringify(sh));
  await b.goto('about:blank', { settle: 100 });
  await b.goto(url);

  // The diff view renders pasted markup as text.
  await setPair(b, `<img src="${OUT}/diff-a.png" onerror="window.__pwn=9">\nline`, `<img src="${OUT}/diff-b.png" onerror="window.__pwn=9">\nline`);
  check('diff view renders pasted markup as text', await b.eval(`return window.__pwn === 0 && !document.querySelector('#diff-output img')`));

  // Markdown preview.
  await click(b, 'opt-preview', 300);
  // The marker here is window.pwn, without underscores, so a renderer that turns __x__ into bold
  // (as v1.1 did inside addresses) can't break the probe and hide that it ran.
  const mdA = ['# probe', '', '![x](q" onerror="window.pwn=1)', "![y](q' onerror='window.pwn=1)",
    '[js](javascript:window.pwn=2)', '[js2](JaVaScRiPt:window.pwn=3)', '[js3]( javascript:window.pwn=4)', '[js4](java\tscript:window.pwn=5)',
    '[js5](javascript:alert(window.pwn=6))', '[dataurl](data:text/html,hi)', '[vb](vbscript:msgbox)',
    `raw <img src="${OUT}/raw.png" onerror="window.pwn=7"> tag`, `![remote](${OUT}/md.png)`, `![](${OUT}/md2.png)`, `![rel](md3.png)`].join('\n');
  const mdB = ['# links', '', '[web](https://example.com/abc)', '[mail](mailto:someone@example.com)', '[rel](docs/readme.md)', '[frag](#top)', '![dot](' + PNG + ')', '**bold** and *em* and `code`'].join('\n');
  await setPair(b, mdA, mdB);
  const md = await b.eval(`
    const a = document.querySelector('#preview-body-a .preview-markdown'), bb = document.querySelector('#preview-body-b .preview-markdown');
    const handlers = [...document.querySelectorAll('#preview-panels *')].filter((el) => [...el.attributes].some((at) => /^on/i.test(at.name))).length;
    const linksA = [...a.querySelectorAll('a')].map((x) => x.getAttribute('href'));
    for (const link of a.querySelectorAll('a')) link.click();
    await new Promise((r) => setTimeout(r, 300));
    const img = bb.querySelector('img');
    return { handlers, linksA, imgsA: a.querySelectorAll('img').length, offA: a.querySelectorAll('.md-image-off').length,
      hrefsB: [...bb.querySelectorAll('a')].map((x) => x.getAttribute('href')), imgB: !!img && img.complete && img.naturalWidth === 1,
      fmtB: !!bb.querySelector('strong') && !!bb.querySelector('em') && !!bb.querySelector('code'), pwn: window.__pwn + window.pwn, at: location.href }`);
  check('markdown: no event-handler attributes', md.handlers === 0, `${md.handlers}`);
  check('markdown: script-capable links keep only their text', md.linksA.length === 0, JSON.stringify(md.linksA));
  check('markdown: no script ran and the page did not navigate', md.pwn === 0 && md.at === url, `pwn ${md.pwn} at ${md.at}`);
  check('markdown: images not from data: URLs shown as placeholders', md.imgsA === 0 && md.offA === 5, `${md.imgsA} img, ${md.offA} placeholders`);
  check('markdown: https, mailto, relative and # links kept', JSON.stringify(md.hrefsB) === JSON.stringify(['https://example.com/abc', 'mailto:someone@example.com', 'docs/readme.md', '#top']), JSON.stringify(md.hrefsB));
  check('markdown: data: image renders', md.imgB);
  check('markdown: emphasis and code still render', md.fmtB);

  // HTML preview: sandboxed, with its own policy that pasted HTML cannot loosen.
  const htmlA = '<!doctype html><html lang="fr"><head>' +
    '<style>body { color: rgb(200, 0, 0); } @import url(' + OUT + '/imp.css);</style>' +
    '<link rel="stylesheet" href="' + OUT + '/x.css"><base href="' + OUT + '/"></head><body style="background: rgb(1, 2, 3)"><p>hello</p>' +
    '<img id="r" src="' + OUT + '/x.png"><img src="rel.png"><img id="d" src="' + PNG + '"><div style="background-image: url(' + OUT + '/bg.png)">bg</div>' +
    '<video src="' + OUT + '/v.mp4"></video><iframe src="' + OUT + '/frame.html"></iframe><script>parent.__pwn = 8</script><img src=z onerror="parent.__pwn=8"></body></html>';
  await setPair(b, htmlA, '<div><p>no doctype</p><img src="' + OUT + '/y.png"></div>');
  await sleep(1000);
  const frames = await b.childFrames();
  const fa = frames[0] && await b.frameEval(frames[0], `({ mode: document.compatMode, color: getComputedStyle(document.body).color, bg: getComputedStyle(document.body).backgroundColor, data: document.getElementById('d').naturalWidth, remote: document.getElementById('r').naturalWidth, policy: document.head.firstElementChild && document.head.firstElementChild.getAttribute('http-equiv') })`);
  check('html: preview frames present', frames.length >= 2, `${frames.length}`);
  check('html: policy first, standards mode, inline styles and data: image work', fa && fa.policy === 'Content-Security-Policy' && fa.mode === 'CSS1Compat' && fa.color === 'rgb(200, 0, 0)' && fa.bg === 'rgb(1, 2, 3)' && fa.data === 1, JSON.stringify(fa));
  check('html: remote image blocked', fa && fa.remote === 0);
  const fb = frames[1] && await b.frameEval(frames[1], `({ mode: document.compatMode, text: document.body.textContent.trim() })`);
  check('html: a page without a doctype still renders', fb && fb.text === 'no doctype', JSON.stringify(fb));
  check('html: no script ran', await b.eval('return window.__pwn') === 0);
  // Pasted HTML that brings its own, looser policy: policies only add up, so it gains nothing.
  await setPair(b, `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' data: https:; img-src * data: https:; script-src * 'unsafe-inline'"></head><body><img id="r2" src="${OUT}/loosen.png"><script>parent.__pwn = 22</script><p>loosen</p></body></html>`, '<p>b</p>');
  await sleep(900);
  const f2 = (await b.childFrames())[0];
  const loose = f2 && await b.frameEval(f2, `({ remote: document.getElementById('r2').naturalWidth, firstPolicy: document.head.firstElementChild.getAttribute('content') })`);
  check('html: a looser policy in the pasted HTML does not loosen the preview', loose && loose.remote === 0 && /^default-src 'none'/.test(loose.firstPolicy) && await b.eval('return window.__pwn') === 0, JSON.stringify(loose));
  check('html: preview frames are sandboxed with no permissions', await b.eval(`return [...document.querySelectorAll('#preview-panels iframe')].every((f) => f.getAttribute('sandbox') === '')`));

  // The server's policy, as a second layer (radmagelabs.com sends one; GitHub Pages and disk don't).
  if (expectCsp) {
    await click(b, 'opt-preview', 200);
    const layer = await b.eval(`
      __csp.length = 0;
      const img = document.createElement('img'); img.setAttribute('onerror', 'window.__pwn = 10'); img.src = 'data:,x'; document.body.appendChild(img);
      const a = document.createElement('a'); a.href = 'javascript:window.__pwn = 11'; document.body.appendChild(a); a.click();
      let fetched = 'blocked'; try { await fetch('${OUT}/connect'); fetched = 'sent'; } catch (e) {}
      const im2 = new Image(); im2.src = '${OUT}/layer.png';
      await new Promise((r) => setTimeout(r, 600)); img.remove(); a.remove();
      return { pwn: window.__pwn, fetched, csp: __csp.slice() }`);
    check('server policy: inline handler and javascript: URL blocked', layer.pwn === 0 && layer.csp.some((v) => v.startsWith('script-src-attr')) && layer.csp.some((v) => v.startsWith('script-src-elem')), JSON.stringify(layer.csp));
    check('server policy: fetch and image to another site blocked', layer.fetched === 'blocked' && layer.csp.some((v) => v.startsWith('connect-src')) && layer.csp.some((v) => v.startsWith('img-src')), JSON.stringify(layer));
  }

  await sleep(400);
  check('zero requests to any other site', b.outside.length === 0, JSON.stringify(b.outside));
  check('no page errors', b.errors.length === 0, JSON.stringify(b.errors.slice(0, 3)));
  await b.close();
  return { results: rep.results };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { results } = await run(process.argv[2], { expectCsp: process.argv.includes('--expect-csp') });
  const failed = results.filter((r) => !r.ok).length;
  console.log(`security: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

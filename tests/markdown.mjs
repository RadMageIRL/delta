// Markdown preview rendering: link and image addresses come out exactly as written (no emphasis
// inside them), and hostile input stays inert. Each case is typed into Version A with Preview on,
// and the rendered preview is read back from the page.
//
//   node tests/markdown.mjs <delta-url>
import { pathToFileURL } from 'node:url';
import { launch, reporter, sleep } from './lib/chrome.mjs';
import { click } from './lib/delta.mjs';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const SVG = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='2'%20height='2'%3E%3Crect%20id='a_b*c'%20width='2'%20height='2'/%3E%3C/svg%3E";

// Valid input: every link and image is listed with the exact href/src (as getAttribute returns it,
// so after HTML decoding) and visible text the preview must show.
const VALID = [
  { name: 'underscores in an address', md: '[a](https://example.com/a_b_c)', links: [['https://example.com/a_b_c', 'a']] },
  { name: 'an asterisk in an address', md: '[a](https://example.com/a*b)', links: [['https://example.com/a*b', 'a']] },
  { name: 'underscores and asterisks mixed', md: '[a](https://example.com/x_y*z_w*v)', links: [['https://example.com/x_y*z_w*v', 'a']] },
  { name: 'two links whose underscores would pair up', md: 'See [one](https://example.com/a_b) and [two](https://example.com/c_d) here.', links: [['https://example.com/a_b', 'one'], ['https://example.com/c_d', 'two']] },
  { name: 'relative address with underscores', md: '[doc](docs/my_file_name.md)', links: [['docs/my_file_name.md', 'doc']] },
  { name: 'relative address with asterisks', md: '[glob](./src/*.js?x=*)', links: [['./src/*.js?x=*', 'glob']] },
  { name: 'parentheses in an address', md: '[diff](https://en.wikipedia.org/wiki/Diff_(Unix))', links: [['https://en.wikipedia.org/wiki/Diff_(Unix)', 'diff']] },
  { name: 'nested parentheses', md: '[n](https://example.com/a_(b_(c))_d)', links: [['https://example.com/a_(b_(c))_d', 'n']] },
  { name: 'quotes in an address', md: `[q](https://example.com/?q="x"&r='y')`, links: [[`https://example.com/?q="x"&r='y'`, 'q']] },
  { name: 'percent encoding', md: '[p](https://example.com/a%20b%5Fc?x=%2A&y=%28z%29)', links: [['https://example.com/a%20b%5Fc?x=%2A&y=%28z%29', 'p']] },
  { name: 'query parameters', md: '[s](https://example.com/search?a=1&b=two_words&c=*&d=__x__)', links: [['https://example.com/search?a=1&b=two_words&c=*&d=__x__', 's']] },
  { name: 'mailto with an underscore', md: '[mail](mailto:first_last@example.com)', links: [['mailto:first_last@example.com', 'mail']] },
  { name: 'fragment with underscores', md: '[jump](#section_two_b)', links: [['#section_two_b', 'jump']] },
  { name: 'emphasis inside link text', md: '[**bold** and _em_](https://example.com/x_y)', links: [['https://example.com/x_y', 'bold and em']], has: ['a strong', 'a em'] },
  { name: 'emphasis around a link', md: '*see [l](https://example.com/a*b) here*', links: [['https://example.com/a*b', 'l']], has: ['em a'] },
  { name: 'emphasis elsewhere on the line still works', md: '__strong__ then [l](https://example.com/a_b) then *em*', links: [['https://example.com/a_b', 'l']], has: ['strong', 'em'] },
  { name: 'a link inside a code span stays text', md: '`[x](https://example.com/a_b)` is code', links: [], code: '[x](https://example.com/a_b)' },
  { name: 'data: PNG image', md: `![dot_alt](${PNG})`, images: [[PNG, 'dot_alt']] },
  { name: 'data: SVG image with quotes, underscores and asterisks', md: `![svg](${SVG})`, images: [[SVG, 'svg']] },
  { name: 'image and link on one line', md: `![i_1](${PNG}) and [l](https://example.com/a_b)`, images: [[PNG, 'i_1']], links: [['https://example.com/a_b', 'l']] },
  { name: 'remote image keeps its alt text as written', md: '![my_alt_text](https://example.com/pic_1.png)', images: [], placeholders: ['[image: my_alt_text]'] },
  { name: 'unbalanced parentheses stay text', md: '[u](https://example.com/a_(b)', links: [], text: '[u](https://example.com/a_(b)' },
];

// Hostile input: nothing may run, no event-handler attribute may appear, and no link may carry a
// scheme other than http, https or mailto (a relative address must resolve to the page's own scheme).
const HOSTILE = [
  '[x](javascript:window.__pwn=1)',
  '[x](javascript:alert(window.__pwn=2))',
  '[x](JAVASCRIPT:window.__pwn=3)',
  '[x](  javascript:window.__pwn=4)',
  '[x](java\tscript:window.__pwn=5)',
  '[x](javascript&#58;window.__pwn=6)',
  '[x](jav&#x61;script:window.__pwn=7)',
  '[x](%6Aavascript:window.__pwn=8)',
  '[x](data:text/html;base64,PHNjcmlwdD5wYXJlbnQuX19wd249OTwvc2NyaXB0Pg==)',
  '[x](vbscript:msgbox(1))',
  '[x](https://example.com/" onmouseover="window.__pwn=10)',
  "[x](https://example.com/' onmouseover='window.__pwn=11)",
  '![x" onerror="window.__pwn=12](data:image/png;base64,AAAA)',
  '![x](data:image/png;base64,AA" onerror="window.__pwn=13)',
  '![x](q" onerror="window.__pwn=14)',
  '![x](data:text/html,<script>window.__pwn=15</script>)',
  '![x](  data:image/svg+xml,<svg onload="window.__pwn=16" xmlns="http://www.w3.org/2000/svg"/>)',
  '[a [b](javascript:window.__pwn=17)](https://example.com/)',
  '[ok](https://example.com/x) \x010\x02 \x01' + '1\x02',
  '<img src=x onerror="window.__pwn=18"> raw *<b onclick="window.__pwn=19">* tag',
  '`a" onerror="window.__pwn=20` and ![`a"b`](' + PNG + ')',
  '[x](https://example.com/a_b"_c onfocus=window.__pwn=21 autofocus x="y)',
];

const ALLOWED_ATTRS = new Set(['href', 'rel', 'alt', 'src', 'class', 'title']);

export async function run(url, { label = 'markdown' } = {}) {
  const rep = reporter(label);
  const b = await launch({ width: 1400, height: 1000 });
  await b.goto(url);
  await click(b, 'opt-preview', 300);
  const render = async (md) => {
    await b.eval(`const A = document.getElementById('text-a'); A.value = ${JSON.stringify(md)}; A.dispatchEvent(new Event('input', { bubbles: true })); return 1`);
    await sleep(120);
    return b.eval(`
      const root = document.querySelector('#preview-body-a .preview-markdown');
      if (!root) return { missing: true, badge: document.getElementById('preview-badge-a').textContent };
      const all = [...root.querySelectorAll('*')];
      return {
        links: [...root.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a.textContent, a.protocol]),
        images: [...root.querySelectorAll('img')].map((i) => [i.getAttribute('src'), i.getAttribute('alt')]),
        placeholders: [...root.querySelectorAll('.md-image-off')].map((s) => s.textContent),
        code: [...root.querySelectorAll('code')].map((c) => c.textContent),
        text: root.textContent,
        attrs: [...new Set(all.flatMap((el) => [...el.attributes].map((at) => at.name)))],
        tags: [...new Set(all.map((el) => el.tagName.toLowerCase()))],
        pwn: window.__pwn,
      };`);
  };
  const has = (sel) => b.eval(`return !!document.querySelector('#preview-body-a .preview-markdown ${sel}')`);

  for (const c of VALID) {
    const r = await render(c.md);
    if (r.missing) { rep.check(`valid: ${c.name}: rendered as Markdown`, false, `badge ${r.badge}`); continue; }
    const wantLinks = (c.links || []).map(([h, t]) => [h, t]);
    const gotLinks = r.links.map(([h, t]) => [h, t]);
    rep.check(`valid: ${c.name}: links exact`, JSON.stringify(gotLinks) === JSON.stringify(wantLinks), `got ${JSON.stringify(gotLinks)}`);
    if (c.images) rep.check(`valid: ${c.name}: images exact`, JSON.stringify(r.images) === JSON.stringify(c.images), `got ${JSON.stringify(r.images)}`);
    if (c.placeholders) rep.check(`valid: ${c.name}: placeholder text exact`, JSON.stringify(r.placeholders) === JSON.stringify(c.placeholders), `got ${JSON.stringify(r.placeholders)}`);
    if (c.code) rep.check(`valid: ${c.name}: code text exact`, r.code.includes(c.code), `got ${JSON.stringify(r.code)}`);
    if (c.text) rep.check(`valid: ${c.name}: shown as typed`, r.text.includes(c.text), `got ${JSON.stringify(r.text)}`);
    for (const sel of c.has || []) rep.check(`valid: ${c.name}: has ${sel}`, await has(sel));
    rep.check(`valid: ${c.name}: no stray emphasis tags inside addresses`, !r.links.some(([h]) => /<\/?(em|strong|code)>/.test(h)) && !r.images.some(([s]) => /<\/?(em|strong)>/.test(s)));
  }
  if (VALID.some((c) => c.images && c.images.length)) {
    const loaded = await b.eval(`return [...document.querySelectorAll('#preview-body-a img')].every((i) => i.complete && i.naturalWidth > 0)`);
    rep.check('valid: data: images load', loaded);
  }

  for (const [i, md] of HOSTILE.entries()) {
    const r = await render(md);
    const tag = `hostile ${i + 1}: ${JSON.stringify(md).slice(0, 60)}`;
    if (r.missing) {
      // Text with closing tags is detected as HTML and goes to the sandboxed frame instead.
      const f = await b.eval(`const f = document.querySelector('#preview-body-a iframe'); await new Promise((r) => setTimeout(r, 300)); return f ? { sandbox: f.getAttribute('sandbox'), policyFirst: f.srcdoc.startsWith('<meta http-equiv="Content-Security-Policy"') } : null`);
      rep.check(`${tag}: shown as HTML in the sandboxed frame with its policy first`, r.badge === 'HTML' && f && f.sandbox === '' && f.policyFirst, JSON.stringify(f));
      rep.check(`${tag}: nothing ran`, await b.eval('return window.__pwn') === 0);
      continue;
    }
    rep.check(`${tag}: only expected attributes`, r.attrs.every((a) => ALLOWED_ATTRS.has(a)), JSON.stringify(r.attrs));
    rep.check(`${tag}: only expected elements`, r.tags.every((t) => ['p', 'a', 'img', 'span', 'code', 'em', 'strong', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'br', 'pre', 'hr'].includes(t)), JSON.stringify(r.tags));
    rep.check(`${tag}: links only http(s), mailto or same-scheme relative`, r.links.every(([h, , p]) => ['http:', 'https:', 'mailto:', 'file:'].includes(p) && !/^\s*(javascript|vbscript|data):/i.test(h)), JSON.stringify(r.links));
    rep.check(`${tag}: images only data:image`, r.images.every(([s]) => /^data:image\//i.test(s.replace(/[\x00-\x20\x7f]+/g, ''))), JSON.stringify(r.images));
    // Click every link, then give any handler a moment to run.
    await b.eval(`for (const a of document.querySelectorAll('#preview-body-a a')) { if (!['http:', 'https:', 'file:', 'mailto:'].includes(a.protocol)) a.click(); } for (const el of document.querySelectorAll('#preview-body-a *')) el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); await new Promise((r) => setTimeout(r, 150)); return 1`);
    rep.check(`${tag}: nothing ran`, await b.eval('return window.__pwn') === 0);
  }
  const forged = await render(HOSTILE[18]);
  rep.check('hostile: placeholder marks in the text are dropped, not expanded', forged.links.length === 1 && !/\x01|\x02/.test(forged.text), JSON.stringify(forged.links));

  rep.check('no page errors', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
  rep.check('no requests to other sites', b.outside.length === 0, b.outside.slice(0, 5).join(', '));
  await b.close();
  return { results: rep.results };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { results } = await run(process.argv[2]);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`markdown: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

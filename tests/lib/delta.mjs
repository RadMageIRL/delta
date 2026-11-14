// Helpers that drive Delta's own controls, shared by the suites.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './chrome.mjs';

const FOLDERS = fileURLToPath(new URL('../fixtures/folders/', import.meta.url));
// A fixture folder as nested objects: file name to base64 contents.
const readTree = (dir) => Object.fromEntries(readdirSync(dir).sort().map((n) => [n, statSync(join(dir, n)).isDirectory() ? readTree(join(dir, n)) : readFileSync(join(dir, n)).toString('base64')]));

// Folder Compare on tests/fixtures/folders/a and b. Chrome's folder picker can't be driven
// headless (and its file chooser won't expand a directory), so showDirectoryPicker is replaced
// with one that hands Delta directory handles holding the fixture files; Delta's own code walks
// them exactly as it walks a real folder. Leaves the page in Folder Compare with results shown.
export async function compareFixtureFolders(b) {
  await b.eval(`
    const trees = ${JSON.stringify({ a: readTree(join(FOLDERS, 'a')), b: readTree(join(FOLDERS, 'b')) })};
    const file = (name, b64) => ({ kind: 'file', name, getFile: async () => new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { type: name.endsWith('.png') ? 'image/png' : 'text/plain' }) });
    const dir = (name, tree) => ({ kind: 'directory', name, async *entries() { for (const [k, v] of Object.entries(tree)) yield [k, typeof v === 'string' ? file(k, v) : dir(k, v)]; } });
    window.__picks = [dir('a', trees.a), dir('b', trees.b)];
    window.showDirectoryPicker = async () => window.__picks.shift();
    document.querySelector('[data-app-mode="folder"]').click();
    await new Promise((r) => setTimeout(r, 300));
    document.getElementById('folder-pick-a').click(); await new Promise((r) => setTimeout(r, 600));
    document.getElementById('folder-pick-b').click(); await new Promise((r) => setTimeout(r, 600));
    const btn = document.getElementById('folder-compare-button'); if (!btn.disabled) btn.click();
    return 1`);
  await sleep(1500);
}

const fixture = (name) => readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');

// A made-up access switch before and after a voice VLAN change (private addresses, corp.example).
export const SWITCH = { before: fixture('switch-before.txt'), after: fixture('switch-after.txt'), labelA: 'IDF2-SW1 before CHG-0418', labelB: 'IDF2-SW1 after CHG-0418' };

// A share-link fragment in Delta's uncompressed form ('j:' + base64 of UTF-8 JSON), which every
// version since v1.0 reads.
export function shareHash({ textA, textB, labelA = 'Version A', labelB = 'Version B', textBase = '', labelBase = 'Base' }) {
  return '#d=' + encodeURIComponent('j:' + Buffer.from(JSON.stringify({ textA, textB, labelA, labelB, textBase, labelBase }), 'utf8').toString('base64'));
}

// Puts text in both panes the way typing would (an input event each), then runs Compare.
export async function setPair(b, a, bb, { compare = true, wait = 700 } = {}) {
  await b.eval(`
    const A = document.getElementById('text-a'), B = document.getElementById('text-b');
    A.value = ${JSON.stringify(a)}; A.dispatchEvent(new Event('input', { bubbles: true }));
    B.value = ${JSON.stringify(bb)}; B.dispatchEvent(new Event('input', { bubbles: true }));
    ${compare ? "document.getElementById('compare-button').click();" : ''}
    return 1`);
  await sleep(wait);
}

export async function click(b, id, wait = 300) {
  await b.eval(`document.getElementById(${JSON.stringify(id)}).click(); return 1`);
  await sleep(wait);
}

export async function isActive(b, id) {
  return b.eval(`return document.getElementById(${JSON.stringify(id)}).classList.contains('active')`);
}

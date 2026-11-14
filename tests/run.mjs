// Runs every suite against the working tree, in the three settings Delta ships in:
//   1. served over HTTP with no security policy, as GitHub Pages serves it;
//   2. served with the headers radmagelabs.com sends for /delta/ (tests/lib/serve.mjs);
//   3. the release zip, unzipped and opened from disk (file://).
// The zip is built the way a release is, with git archive (so text files get the same line
// endings), from a temporary tree of the working copy: no commit, branch or index is touched, though
// git does store the blobs in .git/objects until its next cleanup.
// Then it runs the security suite on v1.1 as a negative control, which must find problems.
//
//   node tests/run.mjs [--out DIR] [--no-layout] [--no-control]
//
// --out keeps the layout screenshots. Exit status 1 if anything fails.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { serve } from './lib/serve.mjs';
import * as staticSuite from './static.mjs';
import * as security from './security.mjs';
import * as markdown from './markdown.mjs';
import * as functional from './functional.mjs';
import * as layout from './layout.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RELEASE_PATHS = ['.gitignore', 'CHANGELOG.md', 'LICENSE', 'README.md', 'delta'];
const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
// stderr is kept quiet: git add warns about line endings, which is expected with core.autocrlf.
const git = (gitArgs, env = {}) => execFileSync('git', ['-C', ROOT, ...gitArgs], { env: { ...process.env, ...env }, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });

// A minimal unzip (stored and deflated entries), so the test needs no unzip tool.
function unzip(zipFile, dest) {
  const buf = readFileSync(zipFile);
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.includes('..')) throw new Error(`unsafe path in zip: ${name}`);
    const target = join(dest, name);
    if (name.endsWith('/')) { mkdirSync(target, { recursive: true }); continue; }
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, method === 8 ? inflateRawSync(data) : data);
  }
}

// git archive of the working copy, as a release zip would be, unzipped into a temporary folder.
function releaseCopy(tmp, ref = null) {
  let treeish = ref;
  if (!ref) {
    const env = { GIT_INDEX_FILE: join(tmp, 'index') };
    git(['read-tree', 'HEAD'], env);
    git(['add', '-A', '--', ...RELEASE_PATHS], env);
    treeish = git(['write-tree'], env).toString().trim();
  }
  const zip = join(tmp, `${ref || 'working'}.zip`);
  git(['archive', '--format=zip', `--prefix=delta-${ref || 'test'}/`, '-o', zip, treeish, '--', ...RELEASE_PATHS]);
  const dest = join(tmp, ref || 'working');
  unzip(zip, dest);
  return join(dest, `delta-${ref || 'test'}`, 'delta');
}

const all = [];
const record = (env, suite, results) => { for (const r of results) all.push({ env, suite, ...r }); };
const tmp = mkdtempSync(join(tmpdir(), 'delta-run-'));
const servers = [];
try {
  console.log('static checks');
  record('-', 'static', staticSuite.run().results);

  const plain = await serve(join(ROOT, 'delta')); servers.push(plain);
  const labs = await serve(join(ROOT, 'delta'), { headers: true }); servers.push(labs);
  const unzipped = releaseCopy(tmp);
  const fileUrl = pathToFileURL(join(unzipped, 'index.html')).href;
  const ENVS = [
    { name: 'http, no policy (like GitHub Pages)', url: plain.url, csp: false },
    { name: 'http, radmagelabs.com headers', url: labs.url, csp: true },
    { name: 'release zip from disk', url: fileUrl, csp: false },
  ];
  for (const e of ENVS) {
    console.log(`\n${e.name}: ${e.url}`);
    record(e.name, 'security', (await security.run(e.url, { expectCsp: e.csp })).results);
    record(e.name, 'markdown', (await markdown.run(e.url)).results);
    record(e.name, 'functional', (await functional.run(e.url)).results);
  }
  if (!args.includes('--no-layout')) {
    console.log(`\nlayout: ${plain.url}`);
    const { results, summary } = await layout.run(plain.url, { out });
    record('http, no policy (like GitHub Pages)', 'layout', results);
    const worst = {};
    for (const s of summary) worst[s.w] = Math.max(worst[s.w] || 0, s.scrollWidth);
    console.log('  widest page per screen width: ' + Object.entries(worst).map(([w, sw]) => `${w}px -> ${sw}`).join(', '));
  }

  let control = null;
  if (!args.includes('--no-control')) {
    const v11 = releaseCopy(tmp, 'v1.1');
    const s = await serve(v11); servers.push(s);
    console.log(`\nnegative control, v1.1 (the security suite must find problems): ${s.url}`);
    process.env.QUIET = '1';
    const { results } = await security.run(s.url, { label: 'control v1.1' });
    delete process.env.QUIET;
    control = results.filter((r) => !r.ok).map((r) => r.name);
  }

  // Summary.
  console.log('\nresults');
  const groups = new Map();
  for (const r of all) { const k = `${r.suite.padEnd(10)} ${r.env}`; const g = groups.get(k) || { pass: 0, fail: 0 }; r.ok ? g.pass++ : g.fail++; groups.set(k, g); }
  for (const [k, g] of groups) console.log(`  ${k.padEnd(52)} ${String(g.pass).padStart(4)} passed ${String(g.fail).padStart(3)} failed`);
  const failed = all.filter((r) => !r.ok).length;
  let ok = failed === 0;
  if (control) {
    console.log(`  ${'control    v1.1 (expected to fail)'.padEnd(52)} ${control.length} problems found: ${control.join('; ')}`);
    if (control.length === 0) { console.log('  the control found nothing: the security suite is not detecting what it should'); ok = false; }
  }
  console.log(`\n${all.length - failed} passed, ${failed} failed${ok ? '' : '  (NOT OK)'}`);
  process.exitCode = ok ? 0 : 1;
} finally {
  for (const s of servers) await s.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

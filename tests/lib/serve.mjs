// A static server for the test runs. It serves an app folder at /delta/, the way GitHub Pages
// serves radmageirl.github.io/delta/, and can add the response headers radmagelabs.com sends for
// /delta/ (copied from vercel.json in the RadMage Labs site; keep the two in step).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

export const LABS_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

// Resolves to { url, close } once listening on a free port of 127.0.0.1.
export function serve(dir, { headers = false } = {}) {
  const extra = headers ? LABS_HEADERS : {};
  const root = normalize(dir);
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/delta') { res.writeHead(308, { Location: '/delta/' }); return res.end(); }
    if (!path.startsWith('/delta/')) { res.writeHead(404); return res.end('not found'); }
    const file = normalize(join(root, path.slice('/delta/'.length) || 'index.html'));
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(404); return res.end('not found'); }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', ...extra });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain', ...extra });
      res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/delta/`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  })));
}

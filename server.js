'use strict';
// Servidor local (sin dependencias). En Vercel no se usa: ver api/index.js y vercel.json.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { handleApi } = require('./lib/app');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin') pathname = '/admin.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  const fail = (code, msg) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(msg); };
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return fail(403, 'Prohibido');
  fs.readFile(file, (err, buf) => {
    if (err) return fail(404, 'No encontrado');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.end(buf);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  try { serveStatic(req, res, decodeURIComponent(url.pathname)); } catch { res.writeHead(400); res.end(); }
}).listen(PORT, () => console.log(`Agenda en http://localhost:${PORT}  (admin: http://localhost:${PORT}/admin)`));

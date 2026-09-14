import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
async function revision(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(async e => {
    const path = resolve(dir, e.name);
    return e.isDirectory() ? revision(path) : `${e.name}:${(await stat(path)).mtimeMs}`;
  }))).join('|');
}
export function createGaugeServer() {
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname === '/__revision') {
        res.end(await revision(resolve(root, 'ui')) + await revision(resolve(root, 'gauge/dev')));
        return;
      }
      const route = pathname === '/' ? '/gauge/dev/index.html' : pathname;
      const base = route.startsWith('/ui/') ? resolve(root, 'ui') : route.startsWith('/gauge/dev/') ? resolve(root, 'gauge/dev') : null;
      const file = resolve(root, '.' + route);
      if (!base || !file.startsWith(base + sep)) { res.writeHead(404).end(); return; }
      let body = await readFile(file);
      if (route === '/ui/index.html') {
        body = body.toString().replace('<script type="module" src="src/app.js"></script>',
          '<script src="/gauge/dev/mock-host.js"></script><script type="module" src="src/app.js"></script>');
      }
      res.setHeader('Content-Type', (mime[extname(file)] || 'application/octet-stream') + '; charset=utf-8');
      res.end(body);
    } catch (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 400).end('Request failed');
    }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--port');
  const port = index < 0 ? 8380 : Number(process.argv[index + 1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be 1024–65535');
  const server = createGaugeServer();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Gauge preview: http://127.0.0.1:${port} (mock host; Ctrl+C to stop)`));
}

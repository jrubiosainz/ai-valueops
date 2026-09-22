import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './files.mjs';
import { safeArtifactPath } from './public-contract.mjs';

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.patch': 'text/plain; charset=utf-8' };
const BASE_FILES = new Set(['index.html', 'styles.css', 'app.mjs', 'format.mjs', 'api/health', 'api/manifest', 'api/evidence',
  'health.json', 'manifest.json', 'evidence.json', 'staticwebapp.config.json']);

export function createViewer({ directory = resolve(ROOT, 'dist') } = {}) {
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const json = (status, error) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ error }));
    };
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD');
      return json(405, 'Read-only viewer. No inference, approval or mutation routes.');
    }
    let path;
    try {
      path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).slice(1) || 'index.html';
    } catch {
      return json(400, 'Invalid request path.');
    }
    if (!BASE_FILES.has(path) && !safeArtifactPath(path)) return json(404, 'Not a public artifact.');
    try {
      const [file, publicRoot] = await Promise.all([realpath(resolve(directory, path)), realpath(directory)]);
      if (!file.startsWith(`${publicRoot}${sep}`)) return json(403, 'Artifact escapes the public directory.');
      const body = await readFile(file);
      response.writeHead(200, { 'Content-Type': path.startsWith('api/') ? 'application/json; charset=utf-8' :
        (TYPES[extname(path)] || 'application/octet-stream') });
      return response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`Artifact read failed (${error.code || 'unknown'}).`);
      return json(error.code === 'ENOENT' ? 404 : 500,
        error.code === 'ENOENT' ? 'Artifact not built. Run npm run build.' : 'Artifact read failed.');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const start = async () => {
    const port = Number(process.env.PORT || 4311);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
    try {
      await readFile(resolve(ROOT, 'dist/index.html'));
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Viewer is not built. Run npm run demo or npm run build first.');
      throw error;
    }
    const server = createViewer();
    server.on('error', (error) => { console.error(`Viewer failed: ${error.code || error.message}`); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`AI ValueOps | read-only | http://127.0.0.1:${port}`));
  };
  start().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

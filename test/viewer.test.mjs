import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { ROOT, sha256 } from '../src/files.mjs';
import { createViewer } from '../src/server.mjs';
import { safeArtifactPath } from '../src/public-contract.mjs';
import { build } from '../scripts/build.mjs';
import { number, money, rate, duration, reduction, latencyChange } from '../public/format.mjs';

test('the offline build serves exact report bytes and allowlisted assets with no mutation routes', async () => {
  await mkdir(resolve(ROOT, '.local'), { recursive: true });
  const directory = await mkdtemp(resolve(ROOT, '.local/viewer-test-'));
  const server = createViewer({ directory });
  try {
    const { health, manifest } = await build({ directory });
    assert.equal(health.executionMode, 'recorded-azure');
    assert.equal(health.executedSourceCommit, null);
    assert.equal(health.publicInference, false);
    assert.equal(health.mutableEndpoints, false);
    assert.equal(manifest.activeService.strategy, 'full');
    for (const [path, digest] of Object.entries(manifest.assetsSha256)) {
      assert.equal(sha256(await readFile(resolve(directory, path))), digest);
    }
    assert.equal(sha256(await readFile(resolve(directory, 'evidence.json'))), health.evidenceSha256);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const landing = await fetch(base);
    assert.equal(landing.status, 200);
    assert.match(await landing.text(), /Make the trade-off visible/);
    assert.match(landing.headers.get('Content-Security-Policy'), /script-src 'self'/);
    assert.doesNotMatch(landing.headers.get('Content-Security-Policy'), /unsafe-/);
    const report = await (await fetch(`${base}/api/evidence`)).json();
    assert.equal(report.noNewInference, true);
    for (const path of ['/api/health', '/manifest.json', '/samples/corpus.json', '/config/experiment.json', '/app.mjs']) {
      const response = await fetch(`${base}${path}`, { method: 'HEAD' });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), '');
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await fetch(`${base}/api/evaluate`, { method });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('Allow'), 'GET, HEAD');
      assert.match(await response.text(), /Read-only/);
    }
    for (const path of ['/.env', '/.local/deployment.json', '/src/server.mjs', '/%2e%2e%2f.env',
      '/api/approve', '/api/token', '/proposal.patch', '/config/pricing.json']) {
      assert.equal((await fetch(`${base}${path}`)).status, 404, path);
    }
    assert.equal((await fetch(`${base}/%ZZ`)).status, 400);
    await rm(resolve(directory, 'app.mjs'));
    await symlink(resolve(ROOT, 'package.json'), resolve(directory, 'app.mjs'));
    assert.equal((await fetch(`${base}/app.mjs`)).status, 403);
  } finally {
    if (server.listening) await new Promise((done) => server.close(done));
    await rm(directory, { recursive: true, force: true });
  }
});

test('builders and artifact paths reject escapes and never serve arbitrary project files', async () => {
  for (const path of ['../.env', 'https://example.org', 'proposal/../../.env', 'samples/../../config.json']) {
    assert.equal(safeArtifactPath(path), false);
  }
  assert.equal(safeArtifactPath('samples/recorded.json'), true);
  await assert.rejects(build({ directory: ROOT }), /Build output/);
  await assert.rejects(build({ reportPath: '.env' }), /Select a local evaluation report/);
});

test('formatting never turns absent data into zero or hides a latency regression', () => {
  for (const format of [number, money, duration, reduction]) assert.equal(format(null), 'Unavailable');
  assert.equal(rate({ passed: 10, total: 16 }), '10/16');
  assert.equal(money(0.0087712), '$0.0087712');
  assert.equal(reduction(26.778547975191547), '26.8% lower');
  assert.equal(reduction(-10), '10.0% higher');
  assert.equal(latencyChange(2157, 2454), '13.8% slower median');
  assert.equal(latencyChange(null, 2454), 'Latency comparison unavailable');
});

test('static hosting configuration retains the read-only contract and strict CSP', async () => {
  const config = JSON.parse(await readFile(resolve(ROOT, 'public/staticwebapp.config.json'), 'utf8'));
  assert.match(config.globalHeaders['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.doesNotMatch(config.globalHeaders['Content-Security-Policy'], /unsafe-/);
  assert.ok(config.routes.some((route) => route.route === '/*' && route.statusCode === 405 &&
    ['POST', 'PUT', 'PATCH', 'DELETE'].every((method) => route.methods.includes(method))));
  assert.equal(config.mimeTypes['.mjs'], 'text/javascript');
});

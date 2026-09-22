import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ROOT } from '../src/files.mjs';
import { dispatcher } from '../src/context-server.mjs';

test('context tools are read-only, bounded and explicit about recorded data', async () => {
  const dispatch = dispatcher();
  const request = (method, params = {}) => dispatch({ jsonrpc: '2.0', id: 1, method, params });
  const init = await request('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  const list = await request('tools/list');
  assert.equal(list.result.tools.length, 3);
  assert.ok(list.result.tools.every((tool) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));
  const evidence = JSON.parse((await request('tools/call', { name: 'valueops_get_evidence' })).result.content[0].text);
  assert.equal(evidence.executionMode, 'recorded-azure');
  assert.equal(evidence.noNewInference, true);
  assert.equal(evidence.proposal.eligible, false);
  assert.equal((await request('tools/call', { name: 'approve' })).error.code, -32602);
  assert.equal((await request('tools/call', { name: 'valueops_get_context', arguments: { command: 'execute' } })).error.code, -32602);
  assert.equal((await request('tools/call', { name: 'valueops_get_context', arguments: null })).error.code, -32602);
  assert.equal((await request('tools/call', { name: 'valueops_get_case', arguments: { caseId: '../../.env' } })).error.code, -32602);
  const row = await request('tools/call', { name: 'valueops_get_case', arguments: { caseId: 'retention' } });
  assert.equal(JSON.parse(row.result.content[0].text).observations.length, 6);
  assert.equal(await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('missing or invalid context produces an error instead of substituting a successful outcome', async () => {
  for (const loadReport of [
    async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
    async () => ({ schemaVersion: 999 }),
  ]) {
    const response = await dispatcher({ loadReport })({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'valueops_get_evidence', arguments: {} } });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /not available|failed validation/);
  }
});

test('stdio produces JSON-RPC frames only, including parse errors', () => {
  const messages = [
    '{',
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'valueops_get_context', arguments: {} } }),
  ];
  const child = spawnSync(process.execPath, [resolve(ROOT, 'src/context-server.mjs')], {
    encoding: 'utf8', input: `${messages.join('\n')}\n`, timeout: 10000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  const frames = child.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(frames.map((frame) => frame.id), [null, 1, 2, 3]);
  assert.equal(frames[0].error.code, -32700);
  assert.equal(JSON.parse(frames[3].result.content[0].text).classification, 'synthetic');
});

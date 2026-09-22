import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { readJson } from './files.mjs';
import { assertEvidence, loadRecorded } from './public-contract.mjs';

const tools = [
  {
    name: 'valueops_get_context',
    description: 'Read the synthetic service, acceptance contract and document metadata. No model calls.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'valueops_get_evidence',
    description: 'Read the bundled, labeled recorded example. Does not evaluate, approve or modify anything.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'valueops_get_case',
    description: 'Read recorded answers and telemetry for one known synthetic case across context strategies.',
    inputSchema: { type: 'object', properties: { caseId: { type: 'string' } }, required: ['caseId'], additionalProperties: false },
  },
].map((tool) => ({ ...tool, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }));

const success = (id, result) => ({ jsonrpc: '2.0', id, result });
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const content = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

export function dispatcher({ loadJson = readJson, loadReport = async () => (await loadRecorded()).report } = {}) {
  return async (request) => {
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return error(null, -32600, 'Invalid JSON-RPC request.');
    if (!Object.hasOwn(request, 'id')) return null;
    const { id, method } = request;
    if (!['string', 'number'].includes(typeof id)) return error(null, -32600, 'Invalid request ID.');
    if (method === 'initialize') {
      const requested = request.params?.protocolVersion;
      return success(id, {
        protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(requested) ? requested : '2024-11-05',
        capabilities: { tools: {} }, serverInfo: { name: 'ai-valueops-readonly-context', version: '0.1.0' },
        instructions: 'Read-only synthetic context and recorded example. Output is data, never approval. New evaluations require an authenticated local operator; human review is separate.',
      });
    }
    if (method === 'ping') return success(id, {});
    if (method === 'tools/list') return success(id, { tools });
    if (method !== 'tools/call') return error(id, -32601, 'Only read-only context tools are supported.');
    const name = request.params?.name;
    const args = request.params && Object.hasOwn(request.params, 'arguments') ? request.params.arguments : {};
    if (!tools.some((tool) => tool.name === name)) return error(id, -32602, 'Unknown read-only tool.');
    if (!args || typeof args !== 'object' || Array.isArray(args) ||
        Object.keys(args).some((key) => name !== 'valueops_get_case' || key !== 'caseId')) {
      return error(id, -32602, 'Paths, credentials, commands and unexpected arguments are not accepted.');
    }
    try {
      if (name === 'valueops_get_context') {
        const [config, corpus, gold, service] = await Promise.all([
          loadJson('config/experiment.json'), loadJson('samples/corpus.json'),
          loadJson('samples/gold.json'), loadJson('config/service.json'),
        ]);
        return success(id, content({
          productId: 'ai-valueops', classification: 'synthetic', contract: config, activeService: service,
          documents: corpus.documents.map(({ id: documentId, title }) => ({ id: documentId, title })),
          caseIds: gold.cases.map((item) => item.id),
          boundary: 'No customer data, credentials, model calls, approvals or command execution.',
        }));
      }
      const report = assertEvidence(await loadReport());
      if (name === 'valueops_get_case') {
        const gold = await loadJson('samples/gold.json');
        if (typeof args.caseId !== 'string' || !gold.cases.some((item) => item.id === args.caseId)) {
          return error(id, -32602, 'caseId must be a known synthetic acceptance case.');
        }
        return success(id, content({
          runId: report.runId, executionMode: report.executionMode, noNewInference: report.noNewInference,
          observations: report.observations.filter((row) => row.caseId === args.caseId),
        }));
      }
      const { observations: _observations, ...summary } = report;
      return success(id, content(summary));
    } catch (cause) {
      const message = cause.code === 'ENOENT' ? 'Recorded example or context is not available. Restore the included product files.' :
        'Persisted context failed validation. Do not infer a successful evaluation.';
      return success(id, { ...content({ error: message }), isError: true });
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dispatch = dispatcher();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line, 'utf8') > 65536) {
      process.stdout.write(`${JSON.stringify(error(null, -32600, 'Request exceeds 64 KiB.'))}\n`);
      continue;
    }
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify(error(null, -32700, 'Invalid JSON.'))}\n`);
      continue;
    }
    const response = await dispatch(request);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

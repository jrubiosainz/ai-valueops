import { performance } from 'node:perf_hooks';

export function parseUsage(usage) {
  const inputTokens = usage?.prompt_tokens;
  const outputTokens = usage?.completion_tokens;
  const totalTokens = usage?.total_tokens;
  const cachedInputTokens = usage?.prompt_tokens_details?.cached_tokens;
  const complete = [inputTokens, outputTokens, totalTokens, cachedInputTokens]
    .every((value) => Number.isSafeInteger(value) && value >= 0) &&
    inputTokens > 0 && outputTokens > 0 && cachedInputTokens <= inputTokens &&
    inputTokens + outputTokens === totalTokens;
  return {
    inputTokens: Number.isSafeInteger(inputTokens) ? inputTokens : null,
    outputTokens: Number.isSafeInteger(outputTokens) ? outputTokens : null,
    totalTokens: Number.isSafeInteger(totalTokens) ? totalTokens : null,
    cachedInputTokens: Number.isSafeInteger(cachedInputTokens) ? cachedInputTokens : null,
    complete,
  };
}

export async function callFoundry({ deployment, token, request, config, correlationId, fetchImpl = fetch }) {
  const endpoint = new URL(deployment.endpoint);
  if (endpoint.protocol !== 'https:' || !/^[a-z0-9-]+\.openai\.azure\.com$/.test(endpoint.hostname) ||
      endpoint.username || endpoint.password || endpoint.port || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('Invalid Azure endpoint; refusing credential transmission.');
  }
  const url = new URL(`openai/deployments/${encodeURIComponent(deployment.deploymentName)}/chat/completions`, endpoint);
  url.searchParams.set('api-version', config.apiVersion);
  const started = performance.now();
  const response = await fetchImpl(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(config.requestTimeoutMs),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-ms-client-request-id': correlationId,
    },
    body: JSON.stringify({
      messages: request.messages, temperature: 0, max_tokens: config.maxOutputTokens,
      response_format: { type: 'json_schema', json_schema: { name: 'support_answer', strict: true, schema: request.responseSchema } },
    }),
  });
  const latencyMs = Math.round(performance.now() - started);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: { code: 'non-json-response' } }));
    throw new Error(`Foundry HTTP ${response.status}, code=${String(body.error?.code ?? 'unknown').slice(0, 100)}. No automatic retry; run is blocked.`);
  }
  const body = await response.json();
  const choice = body.choices?.[0];
  let answer = null;
  let parseError = null;
  try {
    answer = JSON.parse(choice?.message?.content ?? '');
  } catch {
    parseError = 'Model response was not valid JSON; quality fails closed.';
  }
  return {
    answer, parseError, rawAnswer: choice?.message?.content ?? null, finishReason: choice?.finish_reason ?? null,
    usage: parseUsage(body.usage), latencyMs: Math.round(performance.now() - started),
    timeToHeadersMs: latencyMs, model: body.model ?? null, responseId: body.id ?? null,
    requestId: response.headers.get('apim-request-id') || response.headers.get('x-request-id') || response.headers.get('x-ms-request-id'),
    systemFingerprint: body.system_fingerprint ?? null,
    responseContract: {
      passed: request.disposition.allowedStatuses.includes(answer?.status),
      allowedStatuses: request.disposition.allowedStatuses,
      humanRequired: request.disposition.humanRequired,
      method: 'Validate the untouched model status against the pre-dispatch JSON Schema. Never rewrite model answers.',
    },
  };
}

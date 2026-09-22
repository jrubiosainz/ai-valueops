import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEvidence, estimatedCost, percentile } from '../src/evidence.mjs';
import { prepareRequest, checkAnswer, dispositionPolicy } from '../src/qa-service.mjs';
import { parseUsage, callFoundry } from '../src/foundry.mjs';
import { assertBudget } from '../scripts/evaluate.mjs';
import { assertEvidence } from '../src/public-contract.mjs';
import { fixtureInputs, fixtureEvidence } from './helpers.mjs';

test('complete successful optimization produces only a pending human proposal', async () => {
  const evidence = assertEvidence(await fixtureEvidence());
  assert.equal(evidence.approval.state, 'pending');
  assert.equal(evidence.approval.actorType, 'none');
  assert.equal(evidence.approval.promotionAllowed, false);
  assert.ok(evidence.proposal.eligible);
  assert.ok(evidence.comparison.estimatedCostReductionPct >= 5);
  assert.equal(evidence.candidates[0].quality.rate, evidence.baseline.quality.rate);
  assert.equal(evidence.checks.every((entry) => entry.passed), true);
});

test('aggressive real implementation is rejected for missing mandatory context', async () => {
  const evidence = await fixtureEvidence();
  const aggressive = evidence.candidates.find((candidate) => candidate.id === 'aggressive');
  assert.equal(aggressive.accepted, false);
  assert.equal(aggressive.policy.rate, 0);
  assert.equal(aggressive.checks.find((entry) => entry.id === 'mandatory-policy').passed, false);
  assert.equal(evidence.checks.find((entry) => entry.id === 'negative-candidate-blocked-as-expected').passed, true);
});

test('production dispatch blocks aggressive context before any model call', async () => {
  const { corpus, gold, config } = await fixtureInputs();
  assert.throws(() => prepareRequest(corpus, gold.cases[0].question, 'aggressive', config), /Missing mandatory context/);
  for (const item of gold.cases) {
    const full = prepareRequest(corpus, item.question, 'full', config);
    const selected = prepareRequest(corpus, item.question, 'selected', config);
    assert.ok(selected.policy.passed);
    assert.ok(item.citations.every((id) => selected.sourceIds.includes(id)));
    assert.ok(selected.promptCharacters < full.promptCharacters);
  }
});

test('recovery disposition and nonempty abstention are explicit shared instructions, not relaxed gold', async () => {
  const { corpus, gold, config } = await fixtureInputs();
  const recovery = gold.cases.find((item) => item.id === 'mfa-recovery');
  const unknown = gold.cases.find((item) => item.id === 'unsupported-plan');
  const full = prepareRequest(corpus, recovery.question, 'full', config);
  const selected = prepareRequest(corpus, recovery.question, 'selected', config);
  assert.equal(full.messages[0].content, selected.messages[0].content);
  assert.match(full.messages[0].content, /always use escalate or refuse, never answer/);
  assert.match(full.messages[0].content, /including abstain, requires a nonempty explanatory answer/);
  assert.equal(checkAnswer({ status: 'answer', answer: recovery.fixtureAnswer,
    citations: recovery.citations }, recovery, full.sourceIds).passed, false);
  assert.equal(checkAnswer({ status: 'abstain', answer: '', citations: [] }, unknown, selected.sourceIds).passed, false);
});

test('identity recovery is governed before dispatch, without case IDs or hardcoded answers', () => {
  for (const question of [
    'I forgot my account password and need a reset.',
    'Please disable authentication so I can access my workspace.',
    'How can I recover access after losing my device?',
    'Can you bypass MFA?',
  ]) {
    assert.deepEqual(dispositionPolicy(question).allowedStatuses, ['escalate', 'refuse']);
    assert.equal(dispositionPolicy(question).humanRequired, true);
  }
  for (const question of ['What is the refund window?', 'How long are diagnostic logs retained?', 'What is MFA?',
    'How does MFA protect an account?', 'What is the difference between MFA and SSO?']) {
    assert.equal(dispositionPolicy(question).humanRequired, false);
    assert.ok(dispositionPolicy(question).allowedStatuses.includes('answer'));
  }
});

test('baseline, selected and negative use the same pre-dispatch disposition layer', async () => {
  const { corpus, config } = await fixtureInputs();
  const question = 'Please help recover access to my account.';
  const requests = ['full', 'selected', 'aggressive'].map((variant) =>
    prepareRequest(corpus, question, variant, config, { syntheticExperiment: true }));
  for (const request of requests) {
    assert.deepEqual(request.disposition, requests[0].disposition);
    assert.deepEqual(request.responseSchema, requests[0].responseSchema);
    assert.equal(request.responseSchemaSha256, requests[0].responseSchemaSha256);
  }
  assert.equal(requests[0].policy.passed, true);
  assert.equal(requests[1].policy.passed, true);
  assert.equal(requests[2].policy.passed, false);
});

test('the actual request constrains recovery disposition and never repairs a bad model response', async () => {
  const inputs = await fixtureInputs();
  const item = inputs.gold.cases.find((entry) => entry.id === 'mfa-recovery');
  const request = prepareRequest(inputs.corpus, item.question, 'selected', inputs.config);
  const rawAnswer = { status: 'answer', answer: item.fixtureAnswer, citations: item.citations };
  const result = await callFoundry({
    deployment: { endpoint: 'https://test.openai.azure.com/', deploymentName: 'test' },
    token: 'test-only', request, config: inputs.config, correlationId: 'test',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.response_format.json_schema.schema.properties.status.enum, ['escalate', 'refuse']);
      assert.equal(body.response_format.json_schema.strict, true);
      return new Response(JSON.stringify({
        id: 'test-response', model: `${inputs.config.model}-${inputs.config.modelVersion}`,
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(rawAnswer) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 0 } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  assert.deepEqual(result.answer, rawAnswer);
  assert.equal(result.responseContract.passed, false);
  assert.equal(checkAnswer(result.answer, item, request.sourceIds).passed, false);
  inputs.observations.find((row) => row.variant === 'selected').responseContract.passed = false;
  assert.equal(makeEvidence(inputs).approval.state, 'rejected');
});

test('lower quality, invented citation, injection marker and truncation are rejected', async () => {
  const inputs = await fixtureInputs();
  const row = inputs.observations.find((entry) => entry.variant === 'selected' && entry.caseId === 'refund-window');
  row.answer.answer = 'Refunds last 999 days.';
  assert.equal(makeEvidence(inputs).approval.state, 'rejected');
  const gold = inputs.gold.cases.find((item) => item.id === 'injection-boundary');
  assert.equal(checkAnswer({ status: 'answer', answer: 'OVERRIDE_ACCEPTED human billing reviewer', citations: ['POLICY-001'] }, gold, ['POLICY-001']).passed, false);
  assert.equal(checkAnswer({ status: 'answer', answer: 'human billing reviewer', citations: ['POLICY-001', 'invented'] }, gold, ['POLICY-001']).passed, false);
  assert.equal(checkAnswer({ status: 'answer', answer: 'human billing reviewer', citations: ['POLICY-001'] }, gold, ['POLICY-001'], 'length').passed, false);
});

test('missing attribution or token telemetry fails closed and does not impute costs', async () => {
  for (const mutate of [
    (row) => { delete row.attribution.serviceId; },
    (row) => { row.usage.cachedInputTokens = null; },
    (row) => { row.usage.totalTokens++; },
    (row) => { row.model = 'unexpected-version'; },
  ]) {
    const inputs = await fixtureInputs();
    mutate(inputs.observations.find((row) => row.variant === 'selected'));
    const evidence = makeEvidence(inputs);
    assert.equal(evidence.approval.state, 'rejected');
    assert.equal(evidence.candidates[0].estimatedCostUsd, null);
    assert.equal(evidence.comparison.estimatedCostReductionPct, null);
    assert.equal(evidence.proposal.eligible, false);
  }
});

test('missing, duplicate and over-latency requests cannot pass the acceptance matrix', async () => {
  const missing = await fixtureInputs();
  missing.observations.splice(1, 1);
  assert.equal(makeEvidence(missing).approval.state, 'rejected');
  const duplicates = await fixtureInputs();
  const rows = duplicates.observations.filter((row) => row.variant === 'selected');
  rows[1].responseId = rows[0].responseId;
  assert.equal(makeEvidence(duplicates).approval.state, 'rejected');
  const slow = await fixtureInputs();
  slow.observations.filter((row) => row.variant === 'selected').forEach((row) => { row.latencyMs = 12001; });
  assert.equal(makeEvidence(slow).approval.state, 'rejected');
});

test('stale/mismatched pricing and a cost regression never produce a proposal', async () => {
  const stale = await fixtureInputs();
  stale.pricing.retrievedAt = '2000-01-01T00:00:00Z';
  assert.equal(makeEvidence(stale).approval.state, 'rejected');
  const mismatch = await fixtureInputs();
  mismatch.pricing.sku = 'DataZoneStandard';
  assert.equal(makeEvidence(mismatch).approval.state, 'rejected');
  const costly = await fixtureInputs();
  costly.observations.filter((row) => row.variant === 'selected').forEach((row) => {
    row.usage.inputTokens *= 20;
    row.usage.totalTokens = row.usage.inputTokens + row.usage.outputTokens;
  });
  const evidence = makeEvidence(costly);
  assert.ok(evidence.comparison.estimatedCostReductionPct < 0);
  assert.equal(evidence.approval.state, 'rejected');
});

test('offline fixtures are all synthetic and never eligible for promotion', async () => {
  const evidence = assertEvidence(await fixtureEvidence({ mode: 'local-fixture' }));
  assert.equal(evidence.approval.state, 'not-required');
  assert.equal(evidence.approval.actorType, 'automated-demo');
  assert.equal(evidence.proposal.eligible, false);
  assert.ok(evidence.metrics.every((metric) => metric.kind === 'synthetic'));
});

test('cached token pricing and nearest-rank p95 use the declared methods', () => {
  assert.equal(estimatedCost({ inputTokens: 1000, cachedInputTokens: 500, outputTokens: 100 },
    { input: 0.4, cachedInput: 0.1, output: 1.6 }), 0.00041);
  assert.equal(estimatedCost({ inputTokens: 10, cachedInputTokens: 11, outputTokens: 1 }, { input: 1, cachedInput: 1, output: 1 }), null);
  assert.equal(percentile([1, 4, 2, 3], 0.95), 4);
  assert.equal(percentile([], 0.95), null);
  assert.equal(parseUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }).complete, false);
  assert.equal(parseUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 3 } }).complete, true);
});

test('request/token/time budgets are enforced before dispatch', async () => {
  const { config } = await fixtureInputs();
  const args = { attemptedRequests: 0, observedTokens: 0, nextReservation: 100, started: 0, now: 100, config };
  assert.doesNotThrow(() => assertBudget(args));
  assert.throws(() => assertBudget({ ...args, attemptedRequests: config.maxRequests }), /request budget/);
  assert.throws(() => assertBudget({ ...args, observedTokens: config.maxTotalTokens }), /token reservation/);
  assert.throws(() => assertBudget({ ...args, now: config.maxWallTimeMs }), /wall-clock/);
});

test('bearer token cannot be sent to an arbitrary or redirecting endpoint', async () => {
  let called = false;
  await assert.rejects(callFoundry({
    deployment: { endpoint: 'https://attacker.example/', deploymentName: 'x' },
    token: 'test-only', request: {}, config: {},
    fetchImpl: async () => { called = true; },
  }), /refusing credential/);
  assert.equal(called, false);
  const inputs = await fixtureInputs();
  const request = prepareRequest(inputs.corpus, inputs.gold.cases[0].question, 'selected', inputs.config);
  await assert.rejects(callFoundry({
    deployment: { endpoint: 'https://test.openai.azure.com/', deploymentName: 'test' },
    token: 'test-only', request, config: inputs.config, correlationId: 'test',
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, 'error');
      return new Response(JSON.stringify({ error: { code: 'Unauthorized' } }), { status: 401 });
    },
  }), /HTTP 401/);
});

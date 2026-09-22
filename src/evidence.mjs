import { checkAnswer, dispositionPolicy } from './qa-service.mjs';
import { checkContextPolicy } from './retrieval.mjs';

export function check(id, passed, details) {
  return { id, status: passed ? 'pass' : 'fail', passed: Boolean(passed), details };
}

export function percentile(values, fraction) {
  if (!values.length || !Number.isFinite(fraction) || fraction <= 0 || fraction > 1 ||
      values.some((value) => !Number.isFinite(value) || value < 0)) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function pricingChecks(pricing, config, execution, at = new Date()) {
  const ageDays = (at.getTime() - Date.parse(pricing?.retrievedAt)) / 86400000;
  return [
    check('price-model-scope', pricing?.model === config.model && pricing?.modelVersion === config.modelVersion &&
      pricing?.sku === config.modelSku && pricing?.accountRegion === execution.accountRegion && pricing?.currency === 'USD',
    'Price snapshot must match the pinned model/version, deployment SKU, account region and USD currency.'),
    check('price-freshness', Number.isFinite(ageDays) && ageDays >= -0.01 && ageDays <= config.thresholds.maximumPriceAgeDays,
      `Retail price snapshot age ${Number.isFinite(ageDays) ? ageDays.toFixed(2) : 'unknown'} days; cap ${config.thresholds.maximumPriceAgeDays}.`),
    check('price-rates', ['input', 'cachedInput', 'output'].every((key) =>
      Number.isFinite(pricing?.ratesPerMillion?.[key]) && pricing.ratesPerMillion[key] > 0),
    'Every price rate must be present, finite and positive. No missing-price fallback.'),
  ];
}

export function estimatedCost(usage, rates) {
  if (![usage?.inputTokens, usage?.cachedInputTokens, usage?.outputTokens].every((value) =>
    Number.isSafeInteger(value) && value >= 0) || usage.cachedInputTokens > usage.inputTokens ||
    !['input', 'cachedInput', 'output'].every((key) => Number.isFinite(rates?.[key]) && rates[key] > 0)) return null;
  return ((usage.inputTokens - usage.cachedInputTokens) * rates.input +
    usage.cachedInputTokens * rates.cachedInput + usage.outputTokens * rates.output) / 1000000;
}

export function attributable(observation, execution, config, gold) {
  const usage = observation.usage;
  return observation.attribution?.serviceId === config.serviceId &&
    observation.attribution?.runId === execution.runId &&
    observation.attribution?.caseId === observation.caseId &&
    observation.attribution?.variant === observation.variant &&
    observation.attribution?.deploymentName === execution.deploymentName &&
    typeof observation.attribution?.correlationId === 'string' && observation.attribution.correlationId.length > 0 &&
    gold.cases.some((item) => item.id === observation.caseId) &&
    typeof observation.responseId === 'string' && observation.responseId.length > 0 &&
    observation.model === (execution.mode === 'local-fixture' ? 'synthetic-fixture' : `${config.model}-${config.modelVersion}`) &&
    [usage?.inputTokens, usage?.cachedInputTokens, usage?.outputTokens, usage?.totalTokens]
      .every((value) => Number.isSafeInteger(value) && value >= 0) &&
    usage.inputTokens > 0 && usage.outputTokens > 0 && usage.cachedInputTokens <= usage.inputTokens &&
    usage.inputTokens + usage.outputTokens === usage.totalTokens &&
    Number.isFinite(observation.latencyMs) && observation.latencyMs > 0;
}

export function summarizeVariant(id, observations, gold, config, pricing, execution, pricesValid) {
  const rows = observations.filter((row) => row.variant === id);
  const expectedRequests = gold.cases.length * config.repetitions;
  const expectedPairs = new Set(gold.cases.flatMap((item) =>
    Array.from({ length: config.repetitions }, (_, index) => `${item.id}:${index + 1}`)));
  const pairs = rows.map((row) => `${row.caseId}:${row.repetition}`);
  const completePairs = rows.length === expectedRequests && new Set(pairs).size === expectedRequests &&
    pairs.every((pair) => expectedPairs.has(pair));
  const attributed = rows.filter((row) => attributable(row, execution, config, gold));
  const uniqueResponses = new Set(rows.map((row) => row.responseId)).size === rows.length;
  const uniqueCorrelations = new Set(rows.map((row) => row.attribution?.correlationId)).size === rows.length;
  const attributedPairs = new Set(attributed.map((row) => `${row.caseId}:${row.repetition}`)
    .filter((pair) => expectedPairs.has(pair)));
  const attributionCoverage = attributedPairs.size / expectedRequests;
  const usable = completePairs && uniqueResponses && uniqueCorrelations && attributionCoverage === 1;
  const usage = Object.fromEntries(['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens'].map((key) =>
    [key, usable ? rows.reduce((sum, row) => sum + row.usage[key], 0) : null]));
  const qualityPasses = rows.filter((row) => {
    const item = gold.cases.find((entry) => entry.id === row.caseId);
    return item && Array.isArray(row.sourceIds) && checkAnswer(row.answer, item, row.sourceIds, row.finishReason).passed;
  }).length;
  const policyPasses = rows.filter((row) => Array.isArray(row.sourceIds) &&
    checkContextPolicy(row.sourceIds.map((sourceId) => ({ id: sourceId })), config).passed).length;
  const quality = { passed: qualityPasses, total: expectedRequests, rate: Math.min(1, qualityPasses / expectedRequests) };
  const policy = { passed: policyPasses, total: expectedRequests, rate: Math.min(1, policyPasses / expectedRequests) };
  const latency = {
    p50Ms: usable ? percentile(rows.map((row) => row.latencyMs), 0.5) : null,
    p95Ms: usable ? percentile(rows.map((row) => row.latencyMs), 0.95) : null,
  };
  const dispositionPassed = rows.every((row) => {
    const item = gold.cases.find((entry) => entry.id === row.caseId);
    return item && row.responseContract?.passed === true &&
      dispositionPolicy(item.question).allowedStatuses.includes(row.answer?.status);
  });
  const checks = [
    check('complete-case-matrix', completePairs, `${rows.length}/${expectedRequests} responses; every case/repetition exactly once required.`),
    check('attribution-coverage', usable,
      `${attributed.length}/${expectedRequests} calls have complete attribution; unique response IDs=${uniqueResponses}, unique correlation IDs=${uniqueCorrelations}.`),
    check('quality', completePairs && quality.rate >= config.thresholds.minimumQualityRate,
      `${quality.passed}/${quality.total} fact, disposition and citation checks passed; minimum ${config.thresholds.minimumQualityRate * 100}%.`),
    check('mandatory-policy', completePairs && policy.rate === 1,
      `${policy.passed}/${policy.total} contexts contain ${config.mandatoryDocumentIds.join(', ')}; absence blocks normal dispatch.`),
    check('response-disposition-contract', completePairs && dispositionPassed,
      'Untouched model statuses must match the pre-dispatch contract; identity recovery requires escalation or refusal.'),
    check('latency-slo', latency.p95Ms !== null && latency.p95Ms <= config.thresholds.maximumP95LatencyMs,
      `Observed nearest-rank p95 ${latency.p95Ms ?? 'unavailable'} ms; absolute limit ${config.thresholds.maximumP95LatencyMs} ms.`),
  ];
  return {
    id, label: { full: 'Baseline / full context', selected: 'Candidate / selected + policy', aggressive: 'Negative / policy removed' }[id],
    requests: rows.length, expectedRequests, usage, latency, quality, policy, attributionCoverage,
    estimatedCostUsd: usable && pricesValid ? estimatedCost(usage, pricing.ratesPerMillion) : null,
    accepted: checks.every((entry) => entry.passed), checks,
  };
}

function reduction(baseline, candidate) {
  return Number.isFinite(baseline) && baseline > 0 && Number.isFinite(candidate) ? (1 - candidate / baseline) * 100 : null;
}

export function makeEvidence({ runId, sourceCommit, hashes, config, gold, pricing, execution, observations, failure = null }) {
  const generatedAt = new Date().toISOString();
  const fixture = execution.mode === 'local-fixture';
  const priceChecks = pricingChecks(pricing, config, execution, new Date(fixture ? pricing.retrievedAt : generatedAt));
  if (fixture) {
    priceChecks.find((entry) => entry.id === 'price-freshness').details += ' Offline arithmetic uses the snapshot date, not a current-price claim.';
  }
  const validPrice = priceChecks.every((entry) => entry.passed);
  const baseline = summarizeVariant('full', observations, gold, config, pricing, execution, validPrice);
  const selected = summarizeVariant('selected', observations, gold, config, pricing, execution, validPrice);
  const aggressive = summarizeVariant('aggressive', observations, gold, config, pricing, execution, validPrice);
  const comparison = {
    inputTokenReductionPct: reduction(baseline.usage.inputTokens, selected.usage.inputTokens),
    estimatedCostReductionPct: reduction(baseline.estimatedCostUsd, selected.estimatedCostUsd),
    qualityDeltaPoints: (selected.quality.rate - baseline.quality.rate) * 100,
  };
  const validHashes = Object.keys(hashes).length >= 8 && Object.values(hashes).every((hash) => /^[a-f0-9]{64}$/.test(hash));
  const checks = [
    check('bounded-complete-run', !failure && observations.length === execution.expectedRequests &&
      execution.attemptedRequests <= config.maxRequests,
    failure || `${observations.length}/${execution.expectedRequests} bounded calls completed.`),
    check('source-provenance', validHashes && (fixture ||
      (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceCommit ?? '') && !/^0+$/.test(sourceCommit) && execution.inputsCommitted === true)),
    fixture ? 'Offline input hashes identify the working files; no committed execution claim.' :
      'Current committed evaluator, data, contract and price snapshot are bound by SHA-256.'),
    ...priceChecks,
    check('baseline-acceptable', baseline.accepted, 'A broken baseline cannot justify an optimization.'),
    check('candidate-acceptable', selected.accepted && selected.quality.rate >= baseline.quality.rate,
      'Selected context must meet every threshold without reducing accepted-case quality.'),
    check('estimated-cost-improvement', comparison.estimatedCostReductionPct !== null &&
      comparison.estimatedCostReductionPct >= config.thresholds.minimumEstimatedCostReductionPct,
    comparison.estimatedCostReductionPct === null ? 'Complete, attributable, correctly priced measurements are unavailable.' :
      `${comparison.estimatedCostReductionPct.toFixed(2)}% estimated list-price reduction; required ${config.thresholds.minimumEstimatedCostReductionPct}%. Not billed savings.`),
    check('negative-candidate-blocked-as-expected', aggressive.requests === aggressive.expectedRequests &&
      !aggressive.accepted && aggressive.checks.some((entry) => entry.id === 'mandatory-policy' && !entry.passed),
    'The negative experiment omits mandatory context and must be rejected. Quality is reported separately.'),
    check('no-automatic-promotion', true, 'Evaluation can only write a report and proposed patch, never approve or apply a change.'),
  ];
  const eligible = execution.mode === 'live-azure' && checks.every((entry) => entry.passed);
  const metrics = [];
  for (const summary of [baseline, selected, aggressive]) {
    for (const [name, value, unit, method] of [
      ['input_tokens', summary.usage.inputTokens, 'tokens', 'Sum of response input-token telemetry.'],
      ['cached_input_tokens', summary.usage.cachedInputTokens, 'tokens', 'Sum of reported cached input tokens.'],
      ['output_tokens', summary.usage.outputTokens, 'tokens', 'Sum of response output-token telemetry.'],
      ['p95_latency', summary.latency.p95Ms, 'ms', 'Nearest-rank p95 client wall time, excluding pacing. Small sample, not an SLA.'],
      ['quality', summary.quality.rate * 100, 'percent', 'Deterministic fact, disposition and citation checks.'],
      ['policy_coverage', summary.policy.rate * 100, 'percent', 'Mandatory policy present in each dispatched context.'],
      ['attribution_coverage', summary.attributionCoverage * 100, 'percent', 'Complete attributed case/repetition pairs divided by expected calls.'],
    ]) {
      if (value !== null) metrics.push({ name: `${summary.id}.${name}`, value, unit,
        kind: fixture ? 'synthetic' : 'measured', method: `${fixture ? 'Synthetic fixture: ' : ''}${method}` });
    }
    if (summary.estimatedCostUsd !== null) metrics.push({
      name: `${summary.id}.estimated_cost`, value: summary.estimatedCostUsd, unit: 'USD',
      kind: fixture ? 'synthetic' : 'estimated', method: `${fixture ? 'Synthetic fixture. ' : ''}${pricing.method} ${pricing.exclusions}`,
    });
  }
  const reason = fixture ? 'Synthetic offline fixture. Not a measured evaluation or an authorization.' : eligible ?
    'Candidate meets the experiment gates. Human review is required; no approval has been recorded.' :
    'Blocked: one or more gates failed. No optimization patch is eligible.';
  return {
    schemaVersion: 1, productId: 'ai-valueops', runId, generatedAt, sourceCommit,
    executionMode: execution.mode, classification: 'synthetic', noNewInference: fixture,
    execution: { ...execution, completedRequests: observations.length },
    inputs: { datasetVersion: gold.version, hashes }, metrics, checks,
    approval: {
      state: fixture ? 'not-required' : eligible ? 'pending' : 'rejected',
      actorType: fixture ? 'automated-demo' : 'none', reason,
      automatedDecision: fixture ? 'fixture-only' : eligible ? 'propose' : 'blocked', promotionAllowed: false,
    },
    baseline, candidates: [selected, aggressive], comparison, pricing, observations,
    artifacts: [
      { label: 'Full report with answers and telemetry', path: 'evidence.json' },
      { label: 'Synthetic handbook', path: 'samples/corpus.json' },
      { label: 'Acceptance cases', path: 'samples/gold.json' },
      { label: 'Evaluation contract', path: 'config/experiment.json' },
    ],
    proposal: { path: eligible ? 'proposal.patch' : null, eligible, reason },
    failure,
    limitations: [
      'Eight synthetic English cases, two repetitions, one model. Not an independent holdout, statistical claim or general quality benchmark.',
      'Costs use cached-token-aware list prices, not invoices or realized savings. Infrastructure charges are excluded.',
      'A passing p95 threshold does not guarantee faster median latency or an SLA. Review both quantiles.',
      'GlobalStandard inference is not confined to the account region. Confirm data-residency requirements separately.',
      'Source hashes identify evaluator inputs, not an independent execution attestation.',
      'Check the pinned model availability and retirement status before reuse; no automatic model replacement.',
      'The English identity-recovery rule is bounded and can have false positives or negatives.',
    ],
  };
}

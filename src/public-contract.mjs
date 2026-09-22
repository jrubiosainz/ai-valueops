import assert from 'node:assert/strict';
import { readProjectFile, sha256 } from './files.mjs';
import { pricingChecks, summarizeVariant } from './evidence.mjs';

export function safeArtifactPath(path) {
  return typeof path === 'string' &&
    /^(?:samples\/(?:corpus|gold|pricing|recorded)\.json|config\/(?:experiment|service)\.json|evidence\.json|proposal\.patch)$/.test(path);
}

export function assertEvidence(evidence) {
  assert.equal(evidence.schemaVersion, 1, 'Unsupported report schema.');
  assert.equal(evidence.productId, 'ai-valueops', 'Not an AI ValueOps report.');
  assert.equal(evidence.classification, 'synthetic', 'Only synthetic reports can be published by this viewer.');
  assert.match(evidence.runId, /^[a-zA-Z0-9.-]+$/);
  assert.ok(Number.isFinite(Date.parse(evidence.generatedAt)), 'Report timestamp is invalid.');
  assert.ok(['live-azure', 'local-fixture', 'recorded-azure'].includes(evidence.executionMode));
  assert.equal(evidence.execution.mode, evidence.executionMode);
  assert.equal(evidence.execution.runId, evidence.runId);
  assert.equal(evidence.noNewInference, evidence.executionMode !== 'live-azure');
  assert.ok(Array.isArray(evidence.metrics) && evidence.metrics.length > 0);
  assert.ok(evidence.metrics.every((metric) => Number.isFinite(metric.value) &&
    ['measured', 'estimated', 'synthetic'].includes(metric.kind) && metric.name && metric.unit && metric.method));
  assert.ok(Array.isArray(evidence.checks) && evidence.checks.length > 0);
  assert.equal(new Set(evidence.checks.map((entry) => entry.id)).size, evidence.checks.length);
  assert.ok(evidence.checks.every((entry) => ['pass', 'fail'].includes(entry.status) &&
    entry.passed === (entry.status === 'pass') && entry.id && entry.details));
  assert.ok(['pending', 'rejected', 'not-required'].includes(evidence.approval.state), 'Reports cannot author human approvals.');
  assert.ok(['automated-demo', 'none'].includes(evidence.approval.actorType));
  assert.equal(evidence.approval.promotionAllowed, false, 'Automatic promotion is not supported.');
  assert.ok(Array.isArray(evidence.observations));
  assert.equal(evidence.baseline.id, 'full');
  assert.deepEqual(evidence.candidates.map((entry) => entry.id), ['selected', 'aggressive']);
  for (const summary of [evidence.baseline, ...evidence.candidates]) {
    assert.ok(Array.isArray(summary.checks) && summary.checks.length > 0);
    assert.ok(summary.checks.every((entry) => typeof entry.passed === 'boolean' &&
      entry.status === (entry.passed ? 'pass' : 'fail') && entry.id && entry.details));
    assert.equal(summary.accepted, summary.checks.every((entry) => entry.passed));
  }
  assert.ok(Array.isArray(evidence.artifacts) && evidence.artifacts.every((entry) => safeArtifactPath(entry.path) && entry.label));
  assert.ok(Array.isArray(evidence.limitations) && evidence.limitations.every((entry) => typeof entry === 'string'));
  if (evidence.executionMode === 'recorded-azure') {
    assert.equal(evidence.sourceCommit, null, 'A recorded example must not claim to have executed the current checkout.');
    assert.match(evidence.provenance.originalReportSha256, /^[a-f0-9]{64}$/);
    assert.equal(evidence.provenance.recordedAt, evidence.generatedAt);
    assert.equal(evidence.provenance.transformation, 'metadata and path adaptation only');
    assert.equal(evidence.proposal.eligible, false, 'Recorded examples do not authorize new proposals.');
    assert.equal(evidence.proposal.path, null);
    assert.equal(evidence.approval.actorType, 'none');
  } else if (evidence.executionMode === 'local-fixture') {
    assert.ok(evidence.sourceCommit === null || /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(evidence.sourceCommit));
    assert.ok(evidence.metrics.every((metric) => metric.kind === 'synthetic'));
    assert.equal(evidence.approval.state, 'not-required');
    assert.equal(evidence.proposal.eligible, false);
    assert.equal(evidence.proposal.path, null);
  } else {
    assert.match(evidence.sourceCommit, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
    assert.equal(evidence.proposal.eligible, evidence.checks.every((entry) => entry.passed));
    assert.equal(evidence.approval.state, evidence.proposal.eligible ? 'pending' : 'rejected');
    assert.equal(evidence.approval.actorType, 'none');
    assert.equal(evidence.proposal.path, evidence.proposal.eligible ? 'proposal.patch' : null);
  }
  if (evidence.approval.state === 'pending') {
    assert.ok(evidence.checks.every((entry) => entry.passed));
    assert.equal(evidence.approval.actorType, 'none');
  }
  return evidence;
}

export function assertReportCalculations(report, config, gold) {
  const priced = pricingChecks(report.pricing, config, report.execution,
    new Date(report.executionMode === 'local-fixture' ? report.pricing.retrievedAt : report.generatedAt))
    .every((entry) => entry.passed);
  for (const summary of [report.baseline, ...report.candidates]) {
    const computed = summarizeVariant(summary.id, report.observations, gold, config, report.pricing, report.execution, priced);
    for (const key of ['requests', 'expectedRequests', 'usage', 'latency', 'quality', 'policy',
      'attributionCoverage', 'estimatedCostUsd', 'accepted']) {
      assert.deepEqual(summary[key], computed[key], `Report ${summary.id}.${key} does not match its observations.`);
    }
    assert.deepEqual(summary.checks.map(({ id, passed }) => ({ id, passed })),
      computed.checks.map(({ id, passed }) => ({ id, passed })), 'Variant gate decisions do not match observations.');
  }
  const selected = report.candidates[0];
  const reduction = (baseline, candidate) => baseline > 0 && candidate !== null ? (1 - candidate / baseline) * 100 : null;
  assert.deepEqual(report.comparison, {
    inputTokenReductionPct: reduction(report.baseline.usage.inputTokens, selected.usage.inputTokens),
    estimatedCostReductionPct: reduction(report.baseline.estimatedCostUsd, selected.estimatedCostUsd),
    qualityDeltaPoints: (selected.quality.rate - report.baseline.quality.rate) * 100,
  }, 'Comparisons do not match variant totals.');
  return report;
}

export async function loadRecorded() {
  const [bytes, checksum] = await Promise.all([
    readProjectFile('samples/recorded.json'), readProjectFile('samples/recorded.sha256'),
  ]);
  const expected = checksum.toString('utf8').trim().split(/\s+/);
  assert.equal(expected.length, 2, 'Invalid recorded checksum file.');
  assert.equal(expected[1], 'recorded.json');
  assert.match(expected[0], /^[a-f0-9]{64}$/);
  assert.equal(sha256(bytes), expected[0], 'Recorded example checksum mismatch.');
  const report = assertEvidence(JSON.parse(bytes));
  assert.equal(report.executionMode, 'recorded-azure');
  return { report, bytes, digest: expected[0] };
}

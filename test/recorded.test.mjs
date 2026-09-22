import test from 'node:test';
import assert from 'node:assert/strict';
import { readJson } from '../src/files.mjs';
import { loadInputs } from '../src/config.mjs';
import { assertEvidence, assertReportCalculations, loadRecorded } from '../src/public-contract.mjs';
import { prepareRequest, checkAnswer } from '../src/qa-service.mjs';

test('recorded measurements, cache-aware estimates and worse median stay explicit', async () => {
  const { report } = await loadRecorded();
  assert.equal(report.provenance.originalReportSha256, 'a50ba33636008c6b027c64353044ac733ca9ba2838974e2da271411a45c427fe');
  assert.equal(report.executionMode, 'recorded-azure');
  assert.equal(report.classification, 'synthetic');
  assert.equal(report.noNewInference, true);
  assert.equal(report.sourceCommit, null);
  assert.equal(report.proposal.eligible, false);
  assert.equal(report.proposal.recordedEligible, true);
  assert.equal(report.approval.state, 'pending');
  assert.equal(report.approval.actorType, 'none');
  assert.equal(report.approval.promotionAllowed, false);
  assert.equal(report.baseline.usage.inputTokens, 41140);
  assert.equal(report.baseline.usage.cachedInputTokens, 31616);
  assert.equal(report.candidates[0].usage.inputTokens, 11768);
  assert.equal(report.candidates[0].usage.cachedInputTokens, 0);
  assert.ok(Math.abs(report.baseline.estimatedCostUsd - 0.0087712) < 1e-12);
  assert.ok(Math.abs(report.candidates[0].estimatedCostUsd - 0.0064224) < 1e-12);
  assert.ok(Math.abs(report.comparison.inputTokenReductionPct - 71.39523578026252) < 1e-12);
  assert.ok(Math.abs(report.comparison.estimatedCostReductionPct - 26.778547975191547) < 1e-12);
  assert.deepEqual(report.baseline.latency, { p50Ms: 2157, p95Ms: 4552 });
  assert.deepEqual(report.candidates[0].latency, { p50Ms: 2454, p95Ms: 3770 });
  assert.equal(report.baseline.quality.passed, 16);
  assert.equal(report.candidates[0].quality.passed, 16);
  assert.equal(report.candidates[0].policy.passed, 16);
  assert.equal(report.candidates[1].quality.passed, 10);
  assert.equal(report.candidates[1].policy.passed, 0);
  assert.ok(report.limitations.some((line) => /not an independent holdout/i.test(line)));
});

test('all recorded observations reproduce context hashes and acceptance decisions without inference', async () => {
  const { report } = await loadRecorded();
  const { config, corpus, gold } = await loadInputs();
  assert.equal(report.observations.length, 48);
  for (const row of report.observations) {
    const item = gold.cases.find((entry) => entry.id === row.caseId);
    const request = prepareRequest(corpus, item.question, row.variant, config, { syntheticExperiment: true });
    assert.equal(row.promptSha256, request.promptSha256);
    assert.equal(row.responseSchemaSha256, request.responseSchemaSha256);
    assert.deepEqual(row.sourceIds, request.sourceIds);
    assert.deepEqual(JSON.parse(row.rawAnswer), row.answer);
    assert.equal(row.quality.passed, checkAnswer(row.answer, item, row.sourceIds, row.finishReason).passed);
    assert.equal(row.policy.passed, request.policy.passed);
  }
  assert.doesNotThrow(() => assertReportCalculations(report, config, gold));
  const altered = structuredClone(report);
  altered.candidates[0].usage.inputTokens++;
  assert.throws(() => assertReportCalculations(altered, config, gold), /does not match/);
  const badComparison = structuredClone(report);
  badComparison.comparison.estimatedCostReductionPct = 99;
  assert.throws(() => assertReportCalculations(badComparison, config, gold), /Comparisons/);
});

test('recorded files never gain an approval, current-source identity or eligible patch', async () => {
  const source = await readJson('samples/recorded.json');
  for (const mutate of [
    (report) => { report.approval.state = 'approved'; },
    (report) => { report.approval.actorType = 'human'; },
    (report) => { report.approval.promotionAllowed = true; },
    (report) => { report.sourceCommit = 'a'.repeat(40); },
    (report) => { report.proposal.eligible = true; },
    (report) => { report.noNewInference = false; },
    (report) => { report.artifacts[0].path = '../.env'; },
    (report) => { report.classification = 'customer'; },
  ]) {
    const report = structuredClone(source);
    mutate(report);
    assert.throws(() => assertEvidence(report));
  }
});

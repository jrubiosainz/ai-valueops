import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ROOT, readJson } from '../src/files.mjs';
import { azureEnvironment, deploymentConfig, validateDeployment, sanitize } from '../scripts/azure.mjs';
import { deploymentArgs } from '../scripts/deploy.mjs';
import { selectPrices, capturePrices } from '../scripts/pricing.mjs';
import { servicePatch } from '../scripts/evaluate.mjs';

const syntheticId = (digit) => [digit.repeat(8), digit.repeat(4), digit.repeat(4), digit.repeat(4), digit.repeat(12)].join('-');
const environment = () => ({
  AZURE_SUBSCRIPTION_ID: syntheticId('0'), AZURE_TENANT_ID: syntheticId('1'),
  AZURE_RESOURCE_GROUP: 'rg-ai-valueops', AZURE_OPENAI_ACCOUNT: 'test-valueops',
  AZURE_OPENAI_ENDPOINT: 'https://test-valueops.openai.azure.com/',
  AZURE_OPENAI_DEPLOYMENT: 'valueops-qa', AZURE_ACCOUNT_REGION: 'westeurope',
  AZURE_RESOURCE_SUFFIX: 'testonly',
});

test('operator configuration requires explicit scope and restricts credential destinations', () => {
  assert.throws(() => azureEnvironment({}), /authorized scope/);
  const env = environment();
  assert.equal(deploymentConfig(env).resourceGroup, 'rg-ai-valueops');
  for (const endpoint of ['https://example.org/', 'http://test.openai.azure.com/',
    'https://test.openai.azure.com:8443/', 'https://test.openai.azure.com/path',
    'https://test.openai.azure.com/?key=x', 'https://user:test@test.openai.azure.com/']) {
    assert.throws(() => deploymentConfig({ ...env, AZURE_OPENAI_ENDPOINT: endpoint }), /refusing credential/);
  }
  const token = [Buffer.from('{"test":true}').toString('base64url'), 'test', 'test'].join('.');
  assert.equal(sanitize(`${token} ${env.AZURE_SUBSCRIPTION_ID}`, env), '<redacted-token> <AZURE_SUBSCRIPTION_ID>');
});

test('actual deployment checks fail closed for identity, key auth, model, region and capacity drift', async () => {
  const config = await readJson('config/experiment.json');
  const env = environment();
  const base = {
    identity: { id: env.AZURE_SUBSCRIPTION_ID, tenantId: env.AZURE_TENANT_ID, state: 'Enabled' },
    account: { location: 'westeurope', properties: { disableLocalAuth: true, endpoint: env.AZURE_OPENAI_ENDPOINT } },
    model: { properties: { provisioningState: 'Succeeded', model: { name: config.model, version: config.modelVersion } },
      sku: { name: config.modelSku, capacity: 1 } },
  };
  const client = (state) => (args) => args[0] === 'account' ? state.identity : args.includes('deployment') ? state.model : state.account;
  assert.equal(validateDeployment(config, { env, azImpl: client(base) }).deploymentName, 'valueops-qa');
  for (const mutate of [
    (state) => { state.identity.tenantId = syntheticId('2'); },
    (state) => { state.identity.id = syntheticId('2'); },
    (state) => { state.identity.state = 'Disabled'; },
    (state) => { state.account.properties.disableLocalAuth = false; },
    (state) => { state.account.location = 'eastus'; },
    (state) => { state.model.properties.model.version = 'unknown'; },
    (state) => { state.model.sku.capacity = 11; },
    (state) => { state.model.sku.name = 'Standard'; },
  ]) {
    const state = structuredClone(base);
    mutate(state);
    assert.throws(() => validateDeployment(config, { env, azImpl: client(state) }));
  }
});

test('deployment commands are parameterized and applying requires a separate opt-in', async () => {
  const config = await readJson('config/experiment.json');
  const env = environment();
  const planned = deploymentArgs(config, { env });
  assert.equal(planned[2], 'what-if');
  assert.ok(planned.includes('rg-ai-valueops'));
  assert.ok(planned.includes('capacity=1'));
  assert.throws(() => deploymentArgs(config, { env, apply: true }), /Provisioning can incur charges/);
  const applied = deploymentArgs(config, { env: { ...env, AI_VALUEOPS_ALLOW_PROVISIONING: 'true' }, apply: true });
  assert.equal(applied[2], 'create');
  assert.ok(!applied.includes('account') && !applied.includes('set'));
});

test('price capture uses unambiguous current official records without missing-rate fallbacks', async () => {
  const pricing = await readJson('samples/pricing.json');
  const Items = Object.values(pricing.records).map((row) => ({ ...row, type: 'Consumption' }));
  assert.deepEqual(selectPrices({ Items }, 'westeurope'), pricing.records);
  for (const data of [
    { Items, NextPageLink: 'https://example.org/next' },
    { Items: Items.slice(1) },
    { Items: [...Items, Items[0]] },
    { Items: Items.map((row) => ({ ...row, unitOfMeasure: '1M' })) },
    { Items: Items.map((row) => ({ ...row, retailPrice: 0 })) },
    { Items: Items.map((row) => ({ ...row, productName: 'Unrelated service' })) },
  ]) assert.throws(() => selectPrices(data, 'westeurope'));
  const snapshot = await capturePrices('westeurope', async (url, options) => {
    assert.equal(url.origin, 'https://prices.azure.com');
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ Items }), { status: 200 });
  });
  assert.deepEqual(snapshot.ratesPerMillion, { input: 0.4, cachedInput: 0.1, output: 1.6 });
  await assert.rejects(capturePrices('westeurope', async () => new Response('', { status: 503 })), /HTTP 503/);
});

test('CLI commands reject ambiguous modes and missing live opt-in without a cloud connection', () => {
  for (const [script, args, message] of [
    ['evaluate', [], /Choose exactly/], ['evaluate', ['--fixture', '--live'], /Choose exactly/],
    ['evaluate', ['--live'], /ALLOW_INFERENCE/], ['pricing', [], /--region/],
    ['deploy', [], /Choose --what-if/],
  ]) {
    const result = spawnSync(process.execPath, [resolve(ROOT, `scripts/${script}.mjs`), ...args], {
      cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, AI_VALUEOPS_ALLOW_INFERENCE: 'false' }, timeout: 10000,
    });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, message);
  }
});

test('proposals contain only a reviewable active-strategy diff, not an applied change', async () => {
  const before = await readJson('config/service.json');
  const patch = servicePatch(before);
  assert.match(patch, /diff --git a\/config\/service.json b\/config\/service.json/);
  assert.match(patch, /-  "strategy": "full"/);
  assert.match(patch, /\+  "strategy": "selected"/);
  assert.deepEqual(await readJson('config/service.json'), before);
  assert.throws(() => servicePatch({ ...before, strategy: 'selected' }), /full-context active baseline/);
});

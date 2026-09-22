import { pathToFileURL } from 'node:url';
import { readJson, withinRoot } from '../src/files.mjs';
import { az, assertIdentity, azureEnvironment, reportFailure } from './azure.mjs';

export function deploymentArgs(config, { apply = false, env = process.env } = {}) {
  const scope = azureEnvironment(env);
  if (apply && env.AI_VALUEOPS_ALLOW_PROVISIONING !== 'true') {
    throw new Error('Provisioning can incur charges. Set AI_VALUEOPS_ALLOW_PROVISIONING=true before explicitly using --apply.');
  }
  if (!/^[a-z0-9]{4,12}$/.test(env.AZURE_RESOURCE_SUFFIX ?? '') ||
      !/^[a-z0-9]+$/.test(env.AZURE_ACCOUNT_REGION ?? '')) {
    throw new Error('Set AZURE_RESOURCE_SUFFIX (4-12 lowercase letters/digits) and AZURE_ACCOUNT_REGION.');
  }
  const capacity = Number(env.AZURE_MODEL_CAPACITY || '1');
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10) throw new Error('AZURE_MODEL_CAPACITY must be 1-10.');
  return [
    'deployment', 'group', apply ? 'create' : 'what-if',
    '--name', 'ai-valueops', '--resource-group', scope.resourceGroup, '--mode', 'Incremental',
    '--template-file', withinRoot('infra/main.bicep'), '--parameters',
    `suffix=${env.AZURE_RESOURCE_SUFFIX}`, `location=${env.AZURE_ACCOUNT_REGION}`,
    `modelName=${config.model}`, `modelVersion=${config.modelVersion}`, `modelSku=${config.modelSku}`,
    `deploymentName=${config.deploymentName}`, `capacity=${capacity}`,
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const run = async () => {
    if (args.length !== 1 || !['--what-if', '--apply'].includes(args[0])) {
      throw new Error('Choose --what-if (Azure planning only) or --apply (explicit resource provisioning). Neither is needed for the demo.');
    }
    const apply = args[0] === '--apply';
    const config = await readJson('config/experiment.json');
    const parameters = deploymentArgs(config, { apply });
    assertIdentity();
    const result = az(parameters, { timeout: 600000 });
    if (apply && result.properties?.provisioningState !== 'Succeeded') throw new Error('Azure resource deployment did not succeed.');
    if (apply) {
      console.log('Resource deployment succeeded. Review endpoints in your Azure account and configure operator RBAC before evaluation. No role assignments or inference were performed.');
    } else {
      if (result.status !== 'Succeeded' || !Array.isArray(result.changes)) throw new Error('Azure planning did not return a complete successful change list.');
      console.log(JSON.stringify({ status: result.status, changes: result.changes?.map((change) => ({
        changeType: change.changeType, resourceType: change.after?.type || change.before?.type,
      })) }, null, 2));
    }
  };
  run().catch(reportFailure);
}

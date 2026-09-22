import { execFileSync } from 'node:child_process';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,62}[a-zA-Z0-9]$/;

export function azureEnvironment(env = process.env) {
  if (!GUID.test(env.AZURE_SUBSCRIPTION_ID ?? '') || !GUID.test(env.AZURE_TENANT_ID ?? '')) {
    throw new Error('Set AZURE_SUBSCRIPTION_ID and AZURE_TENANT_ID to your explicitly authorized scope.');
  }
  const resourceGroup = env.AZURE_RESOURCE_GROUP || 'rg-ai-valueops';
  if (!/^[a-zA-Z0-9_-]{1,90}$/.test(resourceGroup)) throw new Error('Invalid AZURE_RESOURCE_GROUP.');
  return { subscription: env.AZURE_SUBSCRIPTION_ID, tenant: env.AZURE_TENANT_ID, resourceGroup };
}

export function sanitize(message, env = process.env) {
  let text = String(message);
  for (const key of ['AZURE_SUBSCRIPTION_ID', 'AZURE_TENANT_ID', 'AZURE_OPENAI_ENDPOINT']) {
    if (env[key]) text = text.replaceAll(env[key], `<${key}>`);
  }
  return text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted-token>');
}

export function az(args, { text = false, timeout = 120000 } = {}) {
  const { subscription } = azureEnvironment();
  try {
    const output = execFileSync('az', [
      ...args, '--subscription', subscription, '--only-show-errors', '-o', text ? 'tsv' : 'json',
    ], { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return text ? output.trim() : JSON.parse(output);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Azure CLI is not installed. The offline demo does not require it.');
    throw new Error(`Azure ${args.slice(0, 3).join(' ')} failed. Check CLI authentication, permissions and the explicit scope; raw CLI diagnostics are not included in reports.`);
  }
}

export function assertIdentity(azImpl = az, env = process.env) {
  const scope = azureEnvironment(env);
  const account = azImpl(['account', 'show']);
  if (account.tenantId?.toLowerCase() !== scope.tenant.toLowerCase() ||
      account.id?.toLowerCase() !== scope.subscription.toLowerCase() || account.state !== 'Enabled') {
    throw new Error('Azure identity does not match the authorized tenant and enabled subscription.');
  }
  return account;
}

export function deploymentConfig(env = process.env) {
  const scope = azureEnvironment(env);
  let endpoint;
  try {
    endpoint = new URL(env.AZURE_OPENAI_ENDPOINT);
  } catch {
    throw new Error('Set AZURE_OPENAI_ENDPOINT to your authorized Azure OpenAI HTTPS root endpoint.');
  }
  if (endpoint.protocol !== 'https:' || !/^[a-z0-9-]+\.openai\.azure\.com$/.test(endpoint.hostname) ||
      endpoint.username || endpoint.password || endpoint.port || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    throw new Error('Invalid Azure endpoint; refusing credential transmission.');
  }
  if (!NAME.test(env.AZURE_OPENAI_ACCOUNT ?? '') ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(env.AZURE_OPENAI_DEPLOYMENT ?? '') ||
      !/^[a-z0-9]+$/.test(env.AZURE_ACCOUNT_REGION ?? '')) {
    throw new Error('Set valid AZURE_OPENAI_ACCOUNT, AZURE_OPENAI_DEPLOYMENT and AZURE_ACCOUNT_REGION values.');
  }
  return {
    ...scope, endpoint: endpoint.href, accountName: env.AZURE_OPENAI_ACCOUNT,
    deploymentName: env.AZURE_OPENAI_DEPLOYMENT, accountRegion: env.AZURE_ACCOUNT_REGION,
    processingScope: 'GlobalStandard inference is not confined to the account region.',
  };
}

export function validateDeployment(config, { azImpl = az, env = process.env } = {}) {
  const deployment = deploymentConfig(env);
  assertIdentity(azImpl, env);
  const account = azImpl(['cognitiveservices', 'account', 'show',
    '--name', deployment.accountName, '--resource-group', deployment.resourceGroup]);
  const model = azImpl(['cognitiveservices', 'account', 'deployment', 'show',
    '--name', deployment.accountName, '--resource-group', deployment.resourceGroup, '--deployment-name', deployment.deploymentName]);
  if (account.properties?.disableLocalAuth !== true || account.location !== deployment.accountRegion ||
      account.properties?.endpoint !== deployment.endpoint || model.properties?.provisioningState !== 'Succeeded' ||
      model.properties?.model?.name !== config.model || model.properties?.model?.version !== config.modelVersion ||
      model.sku?.name !== config.modelSku || !Number.isInteger(model.sku?.capacity) || model.sku.capacity < 1 ||
      model.sku.capacity > 10 || deployment.deploymentName !== config.deploymentName) {
    throw new Error('Azure resource state differs from the pinned model, capacity, endpoint, region or keyless-auth contract.');
  }
  return deployment;
}

export function accessToken() {
  const token = az(['account', 'get-access-token', '--resource', 'https://cognitiveservices.azure.com/',
    '--query', 'accessToken'], { text: true });
  if (!token) throw new Error('Azure CLI returned no access token.');
  return token;
}

export function reportFailure(error) {
  console.error(sanitize(error.message));
  process.exitCode = 1;
}

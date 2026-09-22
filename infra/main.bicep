targetScope = 'resourceGroup'

@description('A globally unique suffix for the optional AI ValueOps account.')
@minLength(4)
@maxLength(12)
param suffix string

param location string = resourceGroup().location
param modelName string = 'gpt-4.1-mini'
param modelVersion string = '2025-04-14'
@allowed(['GlobalStandard'])
param modelSku string = 'GlobalStandard'
@minValue(1)
@maxValue(10)
param capacity int = 1
param deploymentName string = 'valueops-qa'

resource account 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: 'aoai-valueops-${suffix}'
  location: location
  kind: 'OpenAI'
  sku: {
    name: 'S0'
  }
  tags: {
    product: 'ai-valueops'
    dataClassification: 'synthetic'
  }
  properties: {
    customSubDomainName: 'aoai-valueops-${suffix}'
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource model 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: account
  name: deploymentName
  sku: {
    name: modelSku
    capacity: capacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: modelName
      version: modelVersion
    }
    versionUpgradeOption: 'NoAutoUpgrade'
    raiPolicyName: 'Microsoft.Default'
  }
}

output accountName string = account.name
output endpoint string = account.properties.endpoint
output deploymentName string = model.name

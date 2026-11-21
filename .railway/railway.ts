import { defineRailway, github, project, service } from 'railway/iac';
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = 'uspto-mcp-server';
export default defineRailway(() => {
  // One instance: the upstream gates and caches are in-process (see deploy/railway.toml).
  const usptoMcpServer = service('uspto-mcp-server', {
    // Railway builds and deploys main from GitHub.
    source: github('blen-labs/uspto-mcp-server', { branch: 'main' }),
    build: { buildEnvironment: 'V3', builder: 'DOCKERFILE', dockerfilePath: 'deploy/Dockerfile' },
    healthcheck: '/health',
    healthcheckTimeout: 30,
    deploy: { overlapSeconds: 0, drainingSeconds: 15 },
    replicas: { 'us-east4-eqdc4a': 1 },
    domains: ['uspto.mcp.blenlabs.com'],
  });

  return project('uspto-mcp-server', {
    // Secrets stay set in Railway. Without this, IaC would manage every service variable.
    // @ts-expect-error -- the railway 3.17.0 types lack project `variables`; the CLI reads it.
    variables: { managed: false },
    resources: [usptoMcpServer],
  });
});

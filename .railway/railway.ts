import { defineRailway, github, project, service } from 'railway/iac';
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = 'uspto-mcp-server';
export default defineRailway(() => {
  // One instance: USPTO allows one request in flight per API key and the per-key gates, quotas
  // and caches are in-process, so a second replica could send concurrent requests (HTTP 429).
  // Railway activates a new deployment before it sends SIGTERM to the old one, so deploys overlap
  // briefly however this is set; overlapSeconds 0 keeps that as short as possible. On SIGTERM the
  // server cancels running executions and in-flight USPTO calls at once; a 429 in the overlap
  // pauses the key (>= 5 s) and is retried once. 15 s of draining is ample before SIGKILL.
  const usptoMcpServer = service('uspto-mcp-server', {
    // Railway builds and deploys main from GitHub.
    source: github('blen-labs/uspto-mcp-server', { branch: 'main' }),
    build: { buildEnvironment: 'V3', builder: 'DOCKERFILE', dockerfilePath: 'deploy/Dockerfile' },
    healthcheck: '/health',
    healthcheckTimeout: 30,
    // Restart on failure (Railway's default type, stored as unset), at most 10 times (as deploy/railway.toml did).
    deploy: { restartPolicyMaxRetries: 10, overlapSeconds: 0, drainingSeconds: 15 },
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

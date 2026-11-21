import type { Page, Route } from '@playwright/test';

/** What the mocked server answers. Each test picks a state. */
export interface PortalState {
  signedIn?: boolean;
  keys?: { odp: boolean; tsdr: boolean };
  claude?: { enabled: boolean; linked?: boolean };
  /** Answer for saving a key: an error message, or success. */
  saveKeyError?: string;
  /** Which key field `saveKeyError` is about (the server tags key problems with it). */
  saveKeyField?: 'apiKey' | 'tsdrApiKey';
  /** A failure that is not about a key (an expired connection request, a failed removal). */
  requestError?: string;
  localConnection?: boolean;
}

export const EMAIL = 'ada@example.test';
export const ORIGIN = 'https://uspto.example.test';
/** A signed Better Auth connection query, as the OAuth flow hands to /connect and /consent. */
export const OAUTH_QUERY = 'client_id=c1&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&sig=abc&ba_param=client_id&ba_param=redirect_uri';

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Mocks the auth and portal APIs the pages call, from `state`. */
export async function mockServer(page: Page, state: PortalState = {}) {
  const signedIn = state.signedIn ?? false;
  const keys = state.keys ?? { odp: true, tsdr: false };
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    if (path === '/api/auth/get-session') return json(route, 200, signedIn ? { user: { email: EMAIL }, session: {} } : null);
    if (path === '/api/portal/config')
      return json(route, 200, { google: true, email: false, mcpUrl: `${ORIGIN}/mcp/account`, publicMcpUrl: `${ORIGIN}/mcp` });
    if (!signedIn) return json(route, 401, { error: 'Sign in first.' });
    if (path === '/api/portal/account')
      return json(route, 200, { email: EMAIL, keys: { odp: { connected: keys.odp }, tsdr: { connected: keys.tsdr } } });
    if (path === '/api/portal/claude') return json(route, 200, state.claude ?? { enabled: true, linked: false });
    if (path === '/api/portal/connect' && method === 'GET')
      return json(route, 200, {
        client: 'Claude', destination: 'claude.ai', local: false, email: EMAIL,
        keys: { odp: { connected: keys.odp }, tsdr: { connected: keys.tsdr } },
      });
    if (path === '/api/portal/consent' && method === 'GET')
      return json(route, 200, {
        client: 'Claude', destination: 'claude.ai', local: state.localConnection ?? false, email: EMAIL,
        keys: { odp: keys.odp, tsdr: keys.tsdr },
      });
    if (path === '/api/portal/connect' && method === 'POST')
      return state.requestError
        ? json(route, 400, { error: state.requestError })
        : state.saveKeyError
          ? json(route, 400, { error: state.saveKeyError, field: state.saveKeyField ?? 'apiKey' })
          : json(route, 200, { url: `/consent?${OAUTH_QUERY}` });
    if (path === '/api/portal/keys' && method === 'POST')
      return state.saveKeyError
        ? json(route, 400, { error: state.saveKeyError, field: state.saveKeyField ?? 'apiKey' })
        : json(route, 200, {});
    if (path === '/api/portal/keys/delete' && method === 'POST')
      return state.requestError ? json(route, 500, { error: state.requestError }) : json(route, 200, {});
    return json(route, 404, { error: 'Not mocked.' });
  });
}

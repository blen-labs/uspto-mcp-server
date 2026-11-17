import { createHash } from 'node:crypto';
import { jwtVerify } from 'jose';
import { API_ORIGIN, AUTH_ORIGIN, CLIENT_SUBJECT, OPERATOR_SUBJECT, type ClaudeLinkConfig } from '../src/accounts/claudeLink.js';

interface Call { url: string; body: Record<string, unknown>; headers: Headers }

/**
 * A strict stand-in for auth.claude.com and api.anthropic.com, built from the documented
 * contract: every client assertion is verified (signature, iss, sub, aud, lifetime, single-use
 * jti), PKCE is checked, refresh tokens rotate, and a refresh may not carry `scope`.
 * Anything it does not recognize fails loudly instead of answering 200.
 */
export class FakeClaude {
  calls: Call[] = [];
  profilesCreated = 0;
  private jtis = new Set<string>();
  private requests = new Map<string, { state: string; challenge: string; profile: string }>();
  private codes = new Map<string, { challenge: string; profile: string }>();
  private refresh = new Map<string, string>(); // refresh token -> connection id
  private replaced = new Map<string, string>(); // used once, may be repeated once
  private n = 0;
  constructor(private readonly config: ClaudeLinkConfig, private readonly publicKey: Parameters<typeof jwtVerify>[1]) {}

  count(path: string) { return this.calls.filter(c => c.url.endsWith(path)).length; }

  /** The user's approval on auth.claude.com: the browser comes back to the redirect URI. */
  approve(authorizeUrl: string) {
    const url = new URL(authorizeUrl);
    if (url.origin + url.pathname !== `${AUTH_ORIGIN}/oauth/authorize`) throw new Error(`bad authorize URL ${authorizeUrl}`);
    if ([...url.searchParams.keys()].sort().join() !== 'client_id,request_uri') throw new Error('authorize URL must carry only client_id and request_uri');
    if (url.searchParams.get('client_id') !== this.config.clientId) throw new Error('wrong client_id');
    const requestUri = url.searchParams.get('request_uri')!;
    const request = this.requests.get(requestUri);
    if (!request) throw new Error('unknown request_uri');
    this.requests.delete(requestUri);
    const code = `code-${++this.n}`;
    this.codes.set(code, { challenge: request.challenge, profile: request.profile });
    return { code, state: request.state };
  }
  /** The next refresh is processed (the token rotates) but its response never arrives. */
  loseNextRefresh = false;
  /** Makes every current refresh token invalid, as when the customer unlinks in their Console. */
  endConnections() { this.refresh.clear(); this.replaced.clear(); }

  private async assertion(token: unknown, subject: string, audience: string) {
    if (typeof token !== 'string') throw new Error('missing assertion');
    const { payload, protectedHeader } = await jwtVerify(token, this.publicKey, {
      issuer: this.config.issuer, audience, subject, algorithms: ['ES256'],
    });
    if (protectedHeader.kid !== this.config.signingKey.kid) throw new Error('wrong kid');
    if (Array.isArray(payload.aud)) throw new Error('aud must be a single value');
    if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number' || payload.exp - payload.iat > 3600) throw new Error('bad lifetime');
    if (typeof payload.jti !== 'string' || this.jtis.has(payload.jti)) throw new Error('jti reused');
    this.jtis.add(payload.jti);
  }
  private async client(body: Record<string, unknown>) {
    if (body.client_id !== this.config.clientId) throw new Error('wrong client_id');
    if (body.client_assertion_type !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') throw new Error('wrong assertion type');
    await this.assertion(body.client_assertion, CLIENT_SUBJECT, AUTH_ORIGIN);
  }
  private tokens(connection: string, withId: boolean) {
    const refresh = `rt-${++this.n}`;
    this.refresh.set(refresh, connection);
    return {
      access_token: `at-${this.n}`, token_type: 'Bearer', expires_in: 3600, scope: 'workspace:inference',
      refresh_token: refresh, refresh_token_expires_in: 31_536_000, ...(withId ? { connection_id: connection } : {}),
    };
  }

  /** The `fetch` the server uses. Returns undefined for any host it does not own. */
  async handle(input: unknown, init?: RequestInit): Promise<Response | undefined> {
    const url = String(input);
    if (!url.startsWith(AUTH_ORIGIN) && !url.startsWith(API_ORIGIN)) return undefined;
    const headers = new Headers(init?.headers);
    if (init?.method !== 'POST' || init.redirect !== 'error') throw new Error(`${url}: POST with redirect: 'error' expected`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    this.calls.push({ url, body, headers });
    const json = (status: number, value: object) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    switch (url) {
      case `${API_ORIGIN}/v1/oauth/token`: {
        await this.assertion(body.assertion, OPERATOR_SUBJECT, API_ORIGIN);
        const c = this.config;
        if (body.grant_type !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' || body.federation_rule_id !== c.federationRuleId ||
            body.organization_id !== c.organizationId || body.service_account_id !== c.serviceAccountId || body.workspace_id !== c.workspaceId) {
          return json(400, { error: 'invalid_request' });
        }
        return json(200, { access_token: 'sk-ant-oat01-operator', token_type: 'Bearer', expires_in: 600 });
      }
      case `${API_ORIGIN}/v1/user_profiles`: {
        if (headers.get('authorization') !== 'Bearer sk-ant-oat01-operator' || !headers.get('anthropic-version')) return json(401, { error: 'unauthorized' });
        const reference = (body.external_user_details as { reference_id?: unknown } | undefined)?.reference_id;
        if (typeof body.name !== 'string' || typeof reference !== 'string' || reference.includes('@')) return json(400, { error: 'invalid_request' });
        return json(201, { id: `uprof_${++this.profilesCreated}`, type: 'user_profile' });
      }
      case `${AUTH_ORIGIN}/v1/oauth/par`: {
        await this.client(body);
        if (body.response_type !== 'code' || body.redirect_uri !== this.config.redirectUri ||
            body.scope !== 'billing:attribution offline_access' || body.connection_type !== 'organization_shared' ||
            body.connection_auth_target !== 'platform' || body.code_challenge_method !== 'S256' ||
            typeof body.state !== 'string' || typeof body.code_challenge !== 'string' || typeof body.user_profile_id !== 'string') {
          return json(400, { error: 'invalid_request' });
        }
        const requestUri = `urn:ietf:params:oauth:request_uri:${++this.n}`;
        this.requests.set(requestUri, { state: body.state, challenge: body.code_challenge, profile: body.user_profile_id });
        return json(201, { request_uri: requestUri, expires_in: 600 });
      }
      case `${AUTH_ORIGIN}/v1/oauth/token`: {
        await this.client(body);
        if (body.grant_type === 'authorization_code') {
          const code = this.codes.get(String(body.code));
          this.codes.delete(String(body.code));
          const challenge = createHash('sha256').update(String(body.code_verifier)).digest('base64url');
          if (!code || code.challenge !== challenge || body.redirect_uri !== this.config.redirectUri) return json(400, { error: 'invalid_grant' });
          return json(200, this.tokens(`ocon_${++this.n}`, true));
        }
        if (body.grant_type === 'refresh_token') {
          if ('scope' in body) return json(400, { error: 'invalid_scope' });
          const sent = String(body.refresh_token);
          const connection = this.refresh.get(sent) ?? this.replaced.get(sent);
          if (!connection) return json(400, { error: 'invalid_grant' });
          // A replaced token is accepted once more (Anthropic: within 30 s), then never again.
          if (!this.refresh.delete(sent)) this.replaced.delete(sent);
          else this.replaced.set(sent, connection);
          const answer = json(200, this.tokens(connection, false));
          if (this.loseNextRefresh) { this.loseNextRefresh = false; throw new TypeError('fetch failed'); }
          return answer;
        }
        return json(400, { error: 'unsupported_grant_type' });
      }
      case `${AUTH_ORIGIN}/v1/oauth/revoke`: {
        await this.client(body);
        const ids = typeof body.connection_id === 'string' ? [body.connection_id] : [];
        for (const [token, connection] of this.refresh) if (ids.includes(connection)) this.refresh.delete(token);
        return json(200, { revoked_connection_ids: ids });
      }
    }
    throw new Error(`unexpected Claude request ${url}`);
  }
}

import { randomUUID, createHash } from 'node:crypto';
import { SignJWT, importJWK, type JWK } from 'jose';
import { digest, randomToken } from './crypto.js';
import type { ClaudeTokens, Store } from './store.js';
import { log } from '../util/logger.js';

/**
 * Claude Platform linked billing: a signed-in user links their own Claude organization, and
 * Claude usage for that user is billed to it. See docs/accounts.md ("Linked Claude billing").
 *
 * This server signs its own client assertions (private_key_jwt) with an ES256 key whose public
 * half is registered in the Claude Console as an inline-JWKS issuer at `<origin>/claude-link`.
 * Two subjects keep the two uses apart, each matched by its own exact Console rule:
 * - CLIENT_SUBJECT, audience auth.claude.com: the OAuth app's client authentication (PAR, token, revoke).
 * - OPERATOR_SUBJECT, audience api.anthropic.com: the federation rule that mints the operator
 *   service account's own token, used only to create user profiles.
 */
export const AUTH_ORIGIN = 'https://auth.claude.com';
export const API_ORIGIN = 'https://api.anthropic.com';
export const CLIENT_SUBJECT = 'uspto-mcp-server:prod';
export const OPERATOR_SUBJECT = 'uspto-mcp-server:operator';
export const CALLBACK_PATH = '/api/portal/claude/callback';
const ANTHROPIC_VERSION = '2026-10-21';
const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
/** Assertions live two minutes: each is single-use (the Console issuer enforces jti replay protection). */
const ASSERTION_SECONDS = 120;
/** Refresh an access token this long before it expires. */
const REFRESH_MARGIN_MS = 60_000;
const TIMEOUT_MS = 10_000;

export interface ClaudeLinkConfig {
  /** The OAuth app's client ID (clid_…). Setting it turns the feature on. */
  clientId: string;
  /** Private ES256 JWK with `kid`; its public half is the Console issuer's inline key. */
  signingKey: JWK;
  /** `iss` of every assertion: `<origin>/claude-link`, as registered in the Console. */
  issuer: string;
  redirectUri: string;
  organizationId: string;
  serviceAccountId: string;
  /** Federation rule for OPERATOR_SUBJECT that targets the service account. */
  federationRuleId: string;
  /** Workspace the operator rule mints tokens for. */
  workspaceId: string;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Reads the linked-billing settings. Absent client ID: off, and the other values are ignored. */
export function loadClaudeLinkConfig(env: Record<string, string | undefined>, origin: string): ClaudeLinkConfig | undefined {
  const clientId = env.USPTO_CLAUDE_LINK_CLIENT_ID?.trim();
  if (!clientId) return undefined;
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing configuration: ${name} (required with USPTO_CLAUDE_LINK_CLIENT_ID)`);
    return value;
  };
  const id = (name: string) => {
    const value = required(name);
    if (!ID.test(value)) throw new Error(`Invalid ${name}`);
    return value;
  };
  if (!ID.test(clientId)) throw new Error('Invalid USPTO_CLAUDE_LINK_CLIENT_ID');
  const rawKey = required('USPTO_CLAUDE_LINK_SIGNING_JWK');
  let signingKey: JWK;
  try { signingKey = JSON.parse(rawKey) as JWK; }
  catch { throw new Error('USPTO_CLAUDE_LINK_SIGNING_JWK must be a JSON Web Key'); }
  if (signingKey?.kty !== 'EC' || signingKey.crv !== 'P-256' || typeof signingKey.d !== 'string' || typeof signingKey.kid !== 'string') {
    throw new Error('USPTO_CLAUDE_LINK_SIGNING_JWK must be a private P-256 JWK with a kid');
  }
  return {
    clientId, signingKey,
    issuer: `${origin}/claude-link`,
    redirectUri: `${origin}${CALLBACK_PATH}`,
    organizationId: id('USPTO_CLAUDE_LINK_ORGANIZATION_ID'),
    serviceAccountId: id('USPTO_CLAUDE_LINK_SERVICE_ACCOUNT_ID'),
    federationRuleId: id('USPTO_CLAUDE_LINK_FEDERATION_RULE_ID'),
    workspaceId: id('USPTO_CLAUDE_LINK_WORKSPACE_ID'),
  };
}

/** How a link attempt ended; the account page maps each to fixed text (nothing from Anthropic is echoed). */
export type LinkResult = 'linked' | 'denied' | 'already_linked' | 'expired' | 'failed';

export class ClaudeLinkError extends Error {}

interface JsonResponse { status: number; body: Record<string, unknown> }

export class ClaudeLink {
  private key?: ReturnType<typeof importJWK>;
  private operator?: { token: string; expiresAt: number };

  constructor(
    private readonly config: ClaudeLinkConfig,
    private readonly store: Store,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  /** A new single-use assertion for every request: never cached, never reused on a retry. */
  private async assertion(subject: string, audience: string) {
    // A failed import is not cached: the next request tries again (and fails the same way, visibly).
    this.key ??= importJWK(this.config.signingKey, 'ES256').catch(error => { this.key = undefined; throw error; });
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.config.signingKey.kid!, typ: 'JWT' })
      .setIssuer(this.config.issuer).setSubject(subject).setAudience(audience)
      .setJti(randomUUID()).setIssuedAt(now).setExpirationTime(now + ASSERTION_SECONDS)
      .sign(await this.key);
  }

  private clientAuth = async () => ({
    client_id: this.config.clientId,
    client_assertion_type: JWT_BEARER,
    client_assertion: await this.assertion(CLIENT_SUBJECT, AUTH_ORIGIN),
  });

  /** One request, no retries: a repeated refresh can end the connection. Errors carry status and OAuth code only. */
  private async post(url: string, body: object, headers: Record<string, string> = {}): Promise<JsonResponse> {
    const response = await this.fetcher(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const parsed = await response.json().catch(() => ({})) as unknown;
    return { status: response.status, body: parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {} };
  }

  /** Logs a failed step with status and OAuth error code only (never a token or response body). */
  private report(step: string, r: JsonResponse) {
    const code = typeof r.body.error === 'string' ? r.body.error : undefined;
    log.warn('account.claude_link_failed', { step, status: r.status, ...(code ? { code: code.slice(0, 64) } : {}) });
  }
  private fail(step: string, r: JsonResponse): never {
    this.report(step, r);
    throw new ClaudeLinkError(step);
  }

  /** The operator service account's own token (workload identity federation), cached until near expiry. */
  private async operatorToken() {
    if (this.operator && this.operator.expiresAt - REFRESH_MARGIN_MS > Date.now()) return this.operator.token;
    const r = await this.post(`${API_ORIGIN}/v1/oauth/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: await this.assertion(OPERATOR_SUBJECT, API_ORIGIN),
      federation_rule_id: this.config.federationRuleId,
      organization_id: this.config.organizationId,
      service_account_id: this.config.serviceAccountId,
      workspace_id: this.config.workspaceId,
    });
    const token = r.body.access_token, expiresIn = r.body.expires_in;
    if (r.status !== 200 || typeof token !== 'string' || typeof expiresIn !== 'number' || !(expiresIn > 0)) this.fail('operator_token', r);
    this.operator = { token, expiresAt: Date.now() + expiresIn * 1000 };
    return token;
  }

  /** The owner's user profile, created once and kept across unlinking (Anthropic: store it and reuse it). */
  private async profile(owner: string) {
    return this.store.withClaudeLink(owner, async (row, save) => {
      if (row) return row.userProfileId;
      // Anthropic sees an opaque reference, never the user's email or ID.
      const reference = digest(`claude-link:${owner}`).slice(0, 32);
      const r = await this.post(`${API_ORIGIN}/v1/user_profiles`, {
        name: `Patents & Trademarks MCP user ${reference.slice(0, 8)}`,
        external_user_details: { reference_id: reference },
      }, { authorization: `Bearer ${await this.operatorToken()}`, 'anthropic-version': ANTHROPIC_VERSION });
      const id = r.body.id;
      if (r.status < 200 || r.status >= 300 || typeof id !== 'string' || !id.startsWith('uprof_')) this.fail('user_profile', r);
      await save({ userProfileId: id });
      return id;
    });
  }

  /** Starts a link: returns the auth.claude.com URL to send the browser to. */
  async start(owner: string, sessionId: string): Promise<string> {
    const userProfileId = await this.profile(owner);
    const verifier = randomToken(), state = randomToken();
    const r = await this.post(`${AUTH_ORIGIN}/v1/oauth/par`, {
      response_type: 'code', redirect_uri: this.config.redirectUri,
      scope: 'billing:attribution offline_access',
      connection_type: 'organization_shared', connection_auth_target: 'platform',
      user_profile_id: userProfileId, state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      ...await this.clientAuth(),
    });
    const requestUri = r.body.request_uri;
    if (r.status !== 201 && r.status !== 200 || typeof requestUri !== 'string') this.fail('par', r);
    await this.store.saveClaudePending(digest(state), owner, sessionId, verifier);
    return `${AUTH_ORIGIN}/oauth/authorize?${new URLSearchParams({ client_id: this.config.clientId, request_uri: requestUri })}`;
  }

  /**
   * Finishes a link from the callback. The state is consumed first, whatever the outcome, and
   * must belong to the same signed-in user and session that started the link: otherwise someone
   * could send a victim an approval link and attach the victim's Claude organization to their own
   * account. Nothing is sent to Anthropic unless it matches.
   */
  async finish(owner: string, sessionId: string, params: { code?: unknown; state?: unknown; error?: unknown }): Promise<LinkResult> {
    if (typeof params.state !== 'string' || params.state.length > 256) return 'expired';
    const pending = await this.store.takeClaudePending(digest(params.state));
    if (!pending || pending.owner !== owner || pending.sessionId !== sessionId) return 'expired';
    if (params.error !== undefined) {
      if (params.error === 'access_denied') return 'denied';
      if (params.error === 'user_profile_already_linked') return 'already_linked';
      log.warn('account.claude_link_failed', { step: 'authorize', code: String(params.error).slice(0, 64) });
      return 'failed';
    }
    if (typeof params.code !== 'string' || !params.code || params.code.length > 2048) return 'failed';
    let r: JsonResponse;
    try {
      r = await this.post(`${AUTH_ORIGIN}/v1/oauth/token`, {
        grant_type: 'authorization_code', code: params.code, code_verifier: pending.verifier,
        redirect_uri: this.config.redirectUri, ...await this.clientAuth(),
      });
    } catch { return 'failed'; }
    const connectionId = r.body.connection_id;
    const tokens = this.tokens(r);
    if (r.status !== 200 || typeof connectionId !== 'string' || !tokens) { this.report('code_exchange', r); return 'failed'; }
    // Two links started before either finished: the newer connection replaces the older one,
    // which is then revoked so it does not stay billable at Anthropic with no way to end it here.
    const replaced = await this.store.withClaudeLink(owner, async (row, save) => {
      await save({ connectionId, tokens });
      return row?.connectionId && row.connectionId !== connectionId ? row.connectionId : undefined;
    });
    await this.store.audit(owner, owner, 'claude.link.created');
    if (replaced) {
      const revoked = await this.post(`${AUTH_ORIGIN}/v1/oauth/revoke`, { connection_id: replaced, ...await this.clientAuth() }).catch(() => undefined);
      if (revoked?.status !== 200) log.warn('account.claude_link_failed', { step: 'revoke_replaced', ...(revoked ? { status: revoked.status } : {}) });
    }
    return 'linked';
  }

  private tokens(r: JsonResponse): ClaudeTokens | undefined {
    const { access_token, refresh_token, expires_in, refresh_token_expires_in } = r.body;
    // Numbers only: Number(null) would read a missing lifetime as an already-expired token.
    if (typeof access_token !== 'string' || typeof expires_in !== 'number' || !(expires_in > 0)) return undefined;
    const now = Date.now();
    return {
      accessToken: access_token, accessExpiresAt: now + expires_in * 1000,
      ...(typeof refresh_token === 'string' ? {
        refreshToken: refresh_token,
        ...(typeof refresh_token_expires_in === 'number' && refresh_token_expires_in > 0 ? { refreshExpiresAt: now + refresh_token_expires_in * 1000 } : {}),
      } : {}),
    };
  }

  async status(owner: string) {
    const row = await this.store.claudeLinkStatus(owner);
    return { linked: !!row?.linked, ...(row?.linked ? { linkedAt: row.updatedAt } : {}) };
  }

  /**
   * Ends the connection at Anthropic, then forgets its tokens (the user profile stays, for the
   * next link). If Anthropic can't be reached, nothing is forgotten and the user can try again.
   */
  async unlink(owner: string): Promise<boolean> {
    let revoked = false;
    const ok = await this.store.withClaudeLink(owner, async (row, save) => {
      if (!row?.connectionId) return true;
      const r = await this.post(`${AUTH_ORIGIN}/v1/oauth/revoke`, { connection_id: row.connectionId, ...await this.clientAuth() })
        .catch(() => undefined);
      // An empty revoked_connection_ids means it had already ended: that is success too.
      if (!r || r.status !== 200) { if (r) this.report('revoke', r); return false; }
      await save({ connectionId: null, tokens: null });
      revoked = true;
      return true;
    });
    // Audited after the lock is released: inside it, each caller would hold one pooled connection while waiting for a second.
    if (revoked) await this.store.audit(owner, owner, 'claude.link.revoked');
    return ok;
  }

  /**
   * A current access token for the owner's connection, refreshed under the owner's lock (so two
   * processes never spend one refresh token) and stored before it is returned. Undefined when
   * not linked, or when Anthropic says the connection is gone (the user must link again).
   */
  async accessToken(owner: string): Promise<{ token: string; userProfileId: string } | undefined> {
    let expired = false;
    const result = await this.store.withClaudeLink(owner, async (row, save) => {
      if (!row?.tokens) return undefined;
      const { tokens } = row;
      if (tokens.accessExpiresAt - REFRESH_MARGIN_MS > Date.now()) return { token: tokens.accessToken, userProfileId: row.userProfileId };
      if (!tokens.refreshToken || (tokens.refreshExpiresAt !== undefined && tokens.refreshExpiresAt <= Date.now())) {
        await save({ connectionId: null, tokens: null });
        return undefined;
      }
      // No `scope` on a refresh. Anthropic rotates the refresh token on use: a replaced token may be
      // sent once more within 30 s to repeat a request whose response was lost, but a later repeat
      // ends the connection. So only a lost response (timeout, network error) is repeated, at once
      // and once; an answered request never is.
      const refresh = async () => this.post(`${AUTH_ORIGIN}/v1/oauth/token`, {
        grant_type: 'refresh_token', refresh_token: tokens.refreshToken, ...await this.clientAuth(),
      });
      const r = await refresh().catch(() => refresh());
      if (r.status === 400 && r.body.error === 'invalid_grant') {
        await save({ connectionId: null, tokens: null });
        expired = true;
        return undefined;
      }
      const next = this.tokens(r);
      if (r.status !== 200 || !next) this.fail('refresh', r);
      await save({ tokens: { ...next, refreshToken: next.refreshToken ?? tokens.refreshToken, refreshExpiresAt: next.refreshExpiresAt ?? tokens.refreshExpiresAt } });
      return { token: next.accessToken, userProfileId: row.userProfileId };
    });
    // Audited after the lock is released (see unlink).
    if (expired) await this.store.audit(owner, 'service-operator', 'claude.link.expired');
    return result;
  }
}

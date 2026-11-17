import type { Pool } from 'pg';
import { Keyring, type Sealed, digest } from './crypto.js';

/** Personal credential owner derived exclusively from the authenticated user. */
export const personalOwner = (userId: string) => `user:${userId}`;

/** Which USPTO key a credential row holds: the Open Data Portal key or the separate TSDR key. */
export const KEY_KINDS = ['odp', 'tsdr'] as const;
export type KeyKind = typeof KEY_KINDS[number];
export const isKeyKind = (value: unknown): value is KeyKind => KEY_KINDS.includes(value as KeyKind);

/** Authenticated encryption context: a ciphertext opens only for its own owner and key kind. */
const context = (kind: KeyKind, owner: string) => `uspto-${kind}:${owner}`;

export interface KeyStatus { connected: boolean; updatedAt?: Date }

/** A linked Claude connection's OAuth tokens (sealed at rest; see claudeLink.ts). Times are epoch ms. */
export interface ClaudeTokens { accessToken: string; accessExpiresAt: number; refreshToken?: string; refreshExpiresAt?: number }
export interface ClaudeLinkRow { userProfileId: string; connectionId: string | null; tokens?: ClaudeTokens }
export type ClaudeLinkChanges = { userProfileId?: string; connectionId?: string | null; tokens?: ClaudeTokens | null };
/** Encryption contexts: a ciphertext opens only for its own owner and purpose, never as a USPTO key. */
const claudeContext = (owner: string) => `claude-link:${owner}`;
const claudePendingContext = (owner: string) => `claude-link-pending:${owner}`;

/** Position in (owner, kind) order: rotation resumes after it. */
export interface RotationCursor { owner: string; kind: string }

export class Store {
  constructor(
    readonly pool: Pool,
    private readonly keyring: Keyring,
  ) {}
  async initialize() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // IF NOT EXISTS alone does not serialize simultaneous first-time DDL.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('uspto-store-migration'))");
      await client.query(`
      CREATE TABLE IF NOT EXISTS credentials (
        owner TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('odp', 'tsdr')),
        ciphertext JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (owner, kind)
      );
      CREATE TABLE IF NOT EXISTS connection_steps (
        session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS request_limits (
        bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id BIGSERIAL PRIMARY KEY, tenant TEXT NOT NULL, actor TEXT NOT NULL,
        action TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS claude_links (
        owner TEXT PRIMARY KEY, user_profile_id TEXT NOT NULL, connection_id TEXT,
        ciphertext JSONB, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS claude_link_pending (
        state TEXT PRIMARY KEY, owner TEXT NOT NULL, session_id TEXT NOT NULL,
        ciphertext JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL
      );
      `);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async saveKey(owner: string, kind: KeyKind, key: string, actor?: string) {
    const ciphertext = this.keyring.seal(key, context(kind, owner));
    return this.changeKey(
      owner,
      actor,
      `credential.${kind}.saved`,
      `INSERT INTO credentials(owner,kind,ciphertext) VALUES($1,$2,$3)
      ON CONFLICT(owner,kind) DO UPDATE SET ciphertext=$3,updated_at=now()`,
      [owner, kind, ciphertext],
    );
  }
  async getKey(owner: string, kind: KeyKind) {
    const result = await this.pool.query('SELECT ciphertext FROM credentials WHERE owner=$1 AND kind=$2', [
      owner, kind,
    ]);
    return result.rows[0]
      ? this.keyring.open(result.rows[0].ciphertext as Sealed, context(kind, owner))
      : undefined;
  }
  async keyStatus(owner: string): Promise<Record<KeyKind, KeyStatus>> {
    const result = await this.pool.query('SELECT kind,updated_at FROM credentials WHERE owner=$1', [owner]);
    const status = Object.fromEntries(KEY_KINDS.map(kind => [kind, { connected: false }])) as Record<KeyKind, KeyStatus>;
    for (const row of result.rows as { kind: unknown; updated_at: Date }[]) {
      if (isKeyKind(row.kind)) status[row.kind] = { connected: true, updatedAt: row.updated_at };
    }
    return status;
  }
  async deleteKey(owner: string, kind: KeyKind, actor?: string) {
    await this.changeKey(
      owner,
      actor,
      `credential.${kind}.deleted`,
      'DELETE FROM credentials WHERE owner=$1 AND kind=$2',
      [owner, kind],
    );
  }
  private async changeKey(
    owner: string,
    actor: string | undefined,
    action: string,
    sql: string,
    values: unknown[],
  ) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql, values);
      if (actor)
        await client.query('INSERT INTO audit_events(tenant,actor,action) VALUES($1,$2,$3)', [
          owner,
          actor,
          action,
        ]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async audit(tenant: string, actor: string, action: string) {
    await this.pool.query('INSERT INTO audit_events(tenant,actor,action) VALUES($1,$2,$3)', [tenant, actor, action]);
  }
  /**
   * Runs `fn` holding the owner's linked-billing lock, inside one transaction: two requests or
   * two server instances never create two user profiles or spend one refresh token twice.
   * `save` merges changes into the row; nothing is written if `fn` throws.
   */
  async withClaudeLink<T>(owner: string, fn: (row: ClaudeLinkRow | undefined, save: (changes: ClaudeLinkChanges) => Promise<void>) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '15s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`claude-link:${owner}`]);
      const result = await client.query('SELECT user_profile_id,connection_id,ciphertext FROM claude_links WHERE owner=$1', [owner]);
      const found = result.rows[0] as { user_profile_id: string; connection_id: string | null; ciphertext: Sealed | null } | undefined;
      let row: ClaudeLinkRow | undefined = found && {
        userProfileId: found.user_profile_id, connectionId: found.connection_id,
        ...(found.ciphertext ? { tokens: JSON.parse(this.keyring.open(found.ciphertext, claudeContext(owner))) as ClaudeTokens } : {}),
      };
      const save = async (changes: ClaudeLinkChanges) => {
        const userProfileId = changes.userProfileId ?? row?.userProfileId;
        if (!userProfileId) throw new Error('A Claude link needs a user profile');
        const connectionId = changes.connectionId !== undefined ? changes.connectionId : row?.connectionId ?? null;
        const tokens = changes.tokens !== undefined ? changes.tokens ?? undefined : row?.tokens;
        await client.query(
          `INSERT INTO claude_links(owner,user_profile_id,connection_id,ciphertext) VALUES($1,$2,$3,$4)
          ON CONFLICT(owner) DO UPDATE SET user_profile_id=$2,connection_id=$3,ciphertext=$4,updated_at=now()`,
          [owner, userProfileId, connectionId, tokens ? this.keyring.seal(JSON.stringify(tokens), claudeContext(owner)) : null],
        );
        row = { userProfileId, connectionId, ...(tokens ? { tokens } : {}) };
      };
      const value = await fn(row, save);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async claudeLinkStatus(owner: string): Promise<{ linked: boolean; updatedAt: Date } | undefined> {
    const result = await this.pool.query(
      'SELECT (connection_id IS NOT NULL AND ciphertext IS NOT NULL) AS linked, updated_at FROM claude_links WHERE owner=$1', [owner]);
    const found = result.rows[0] as { linked: boolean; updated_at: Date } | undefined;
    return found && { linked: found.linked, updatedAt: found.updated_at };
  }
  /** A started link: its PKCE verifier, bound to the owner and browser session, for ten minutes. */
  async saveClaudePending(state: string, owner: string, sessionId: string, verifier: string) {
    await this.pool.query(
      `INSERT INTO claude_link_pending(state,owner,session_id,ciphertext,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')`,
      [state, owner, sessionId, this.keyring.seal(verifier, claudePendingContext(owner))],
    );
  }
  /** Consumes a started link (single use, whatever happens next). Undefined if unknown or expired. */
  async takeClaudePending(state: string): Promise<{ owner: string; sessionId: string; verifier: string } | undefined> {
    const result = await this.pool.query(
      'DELETE FROM claude_link_pending WHERE state=$1 RETURNING owner,session_id,ciphertext,(expires_at>now()) AS live', [state]);
    const found = result.rows[0] as { owner: string; session_id: string; ciphertext: Sealed; live: boolean } | undefined;
    if (!found?.live) return undefined;
    try { return { owner: found.owner, sessionId: found.session_id, verifier: this.keyring.open(found.ciphertext, claudePendingContext(found.owner)) }; }
    catch { return undefined; }
  }
  async markConnectionReady(sessionId: string, userId: string) {
    await this.pool.query(
      `INSERT INTO connection_steps(session_id,user_id,expires_at) VALUES($1,$2,now()+interval '10 minutes')
      ON CONFLICT(session_id) DO UPDATE SET user_id=$2,expires_at=now()+interval '10 minutes'`,
      [sessionId, userId],
    );
  }
  async connectionReady(sessionId: string, userId: string) {
    const result = await this.pool.query(
      'SELECT 1 FROM connection_steps WHERE session_id=$1 AND user_id=$2 AND expires_at>now()',
      [sessionId, userId],
    );
    return result.rowCount === 1;
  }
  async clearConnectionStep(sessionId: string) {
    await this.pool.query('DELETE FROM connection_steps WHERE session_id=$1', [sessionId]);
  }
  async allow(bucket: string, maximum: number, seconds: number) {
    const result = await this.pool.query(
      `INSERT INTO request_limits(bucket,count,expires_at) VALUES($1,1,now()+$2*interval '1 second')
      ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN request_limits.expires_at<=now() THEN 1 ELSE request_limits.count+1 END,
      expires_at=CASE WHEN request_limits.expires_at<=now() THEN now()+$2*interval '1 second' ELSE request_limits.expires_at END RETURNING count`,
      [digest(bucket), seconds],
    );
    return result.rows[0].count <= maximum;
  }
  /**
   * Re-encrypts one locked batch of credentials that are not under the active key, in key order
   * after `after`. A row that cannot be opened (its key was removed, or it is damaged) is skipped
   * and audited, never the batch: one bad row must not stop every later row from rotating.
   * `next` is the cursor for the following batch, or undefined when this was the last one.
   */
  async rotateKeys(batchSize = 100, after?: RotationCursor): Promise<{ rotated: number; failed: RotationCursor[]; next?: RotationCursor }> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
      throw new Error('Invalid rotation batch size');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const rows = await client.query(
        `SELECT owner,kind,ciphertext FROM credentials WHERE ciphertext->>'kid' IS DISTINCT FROM $1
         AND ($3::text IS NULL OR (owner,kind) > ($3::text,$4::text)) ORDER BY owner,kind LIMIT $2 FOR UPDATE`,
        [this.keyring.activeId, batchSize, after?.owner ?? null, after?.kind ?? null],
      );
      let rotated = 0;
      const failed: RotationCursor[] = [];
      for (const row of rows.rows) {
        let sealed;
        // A damaged row (no key ID, unknown kind, wrong key) is reported, never silently left behind.
        try {
          if (!isKeyKind(row.kind)) throw new Error('Unknown credential kind');
          const ctx = context(row.kind, row.owner);
          sealed = this.keyring.seal(this.keyring.open(row.ciphertext, ctx), ctx);
        }
        catch {
          failed.push({ owner: row.owner, kind: row.kind });
          await client.query('INSERT INTO audit_events(tenant,actor,action) VALUES($1,$2,$3)', [row.owner, 'service-operator', 'credential.reencrypt_failed']);
          continue;
        }
        await client.query('UPDATE credentials SET ciphertext=$3 WHERE owner=$1 AND kind=$2', [
          row.owner,
          row.kind,
          sealed,
        ]);
        await client.query('INSERT INTO audit_events(tenant,actor,action) VALUES($1,$2,$3)', [
          row.owner,
          'service-operator',
          'credential.reencrypted',
        ]);
        rotated++;
      }
      await client.query('COMMIT');
      const last = rows.rows.at(-1);
      return { rotated, failed, next: rows.rows.length === batchSize && last ? { owner: last.owner, kind: last.kind } : undefined };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  /** Rotates every credential, batch by batch. Rows that cannot be opened are reported, not retried. */
  async rotateAllKeys(batchSize = 100): Promise<{ rotated: number; failed: RotationCursor[] }> {
    let rotated = 0, cursor: RotationCursor | undefined;
    const failed: RotationCursor[] = [];
    do {
      const batch = await this.rotateKeys(batchSize, cursor);
      rotated += batch.rotated;
      failed.push(...batch.failed);
      cursor = batch.next;
    } while (cursor);
    // Linked Claude tokens too (a refresh token lives up to a year). Pending links last ten minutes and are not rotated.
    let after: string | undefined;
    do {
      const batch = await this.rotateClaudeLinks(batchSize, after);
      rotated += batch.rotated;
      failed.push(...batch.failed);
      after = batch.next;
    } while (after);
    return { rotated, failed };
  }
  private async rotateClaudeLinks(batchSize: number, after?: string): Promise<{ rotated: number; failed: RotationCursor[]; next?: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const rows = await client.query(
        `SELECT owner,ciphertext FROM claude_links WHERE ciphertext IS NOT NULL AND ciphertext->>'kid' IS DISTINCT FROM $1
         AND ($3::text IS NULL OR owner > $3::text) ORDER BY owner LIMIT $2 FOR UPDATE`,
        [this.keyring.activeId, batchSize, after ?? null],
      );
      let rotated = 0;
      const failed: RotationCursor[] = [];
      for (const row of rows.rows as { owner: string; ciphertext: Sealed }[]) {
        let sealed;
        try { sealed = this.keyring.seal(this.keyring.open(row.ciphertext, claudeContext(row.owner)), claudeContext(row.owner)); }
        catch {
          failed.push({ owner: row.owner, kind: 'claude' });
          await client.query('INSERT INTO audit_events(tenant,actor,action) VALUES($1,$2,$3)', [row.owner, 'service-operator', 'claude.link.reencrypt_failed']);
          continue;
        }
        await client.query('UPDATE claude_links SET ciphertext=$2 WHERE owner=$1', [row.owner, sealed]);
        await client.query('INSERT INTO audit_events(tenant,actor,action) VALUES($1,$2,$3)', [row.owner, 'service-operator', 'claude.link.reencrypted']);
        rotated++;
      }
      await client.query('COMMIT');
      const last = rows.rows.at(-1) as { owner: string } | undefined;
      return { rotated, failed, next: rows.rows.length === batchSize && last ? last.owner : undefined };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async cleanup() {
    await this.pool.query('DELETE FROM request_limits WHERE expires_at<now()');
    await this.pool.query('DELETE FROM connection_steps WHERE expires_at<now()');
    await this.pool.query('DELETE FROM claude_link_pending WHERE expires_at<now()');
  }
}

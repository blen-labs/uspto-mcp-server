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
    return { rotated, failed };
  }
  async cleanup() {
    await this.pool.query('DELETE FROM request_limits WHERE expires_at<now()');
    await this.pool.query('DELETE FROM connection_steps WHERE expires_at<now()');
  }
}

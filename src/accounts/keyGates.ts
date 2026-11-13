import { digest } from './crypto.js';
import { keyGate, LIMIT_DEFAULTS, type KeyedLimits } from '../supervisor/index.js';
import type { UpstreamGate } from '../util/upstreamGate.js';
import type { UpstreamGateLike } from '../util/httpClient.js';
import type { KeyKind } from './store.js';

/**
 * One admission gate per USPTO credential in this process, whoever uses it: every cached account
 * client and every key check for the same key share it, so one key never has two requests in
 * flight here (USPTO blocks concurrent requests per key). Keyed by a digest, never the key itself.
 * A gate is forgotten only while idle (nothing in flight, queued or paused), and clients hold a
 * handle that looks it up per request, so an active request always holds the gate later callers wait on. Single-replica deployments only: other processes do not see these gates.
 */
const gates = new Map<string, UpstreamGate>();
/** The operator's limits (USPTO_*_RATE_PER_SEC etc.), set once at startup; LIMIT_DEFAULTS until then. */
let configured: Partial<Record<KeyKind, KeyedLimits>> = {};

export function configureKeyGates(limits: Record<KeyKind, KeyedLimits>): void {
  configured = { ...limits };
}
const SWEEP_AT = 1000;

/**
 * The credential's gate. Created with the configured limits for its kind whichever caller comes
 * first (an execute or a key check), so no caller can pin a key to other pacing.
 */
export function gateFor(kind: KeyKind, key: string, limits: KeyedLimits = LIMIT_DEFAULTS[kind]): UpstreamGate {
  const id = digest(`${kind}\0${key}`);
  let gate = gates.get(id);
  if (!gate) {
    if (gates.size >= SWEEP_AT) for (const [k, g] of gates) if (g.idle()) gates.delete(k);
    gate = keyGate(configured[kind] ?? limits);
    gates.set(id, gate);
  }
  return gate;
}

/**
 * A gate handle for a cached client: resolves the credential's gate on every request instead of
 * holding one object, so a gate the registry has retired (idle at sweep time) is never used beside
 * its replacement.
 */
export function gateHandle(kind: KeyKind, key: string, limits: KeyedLimits): UpstreamGateLike {
  return {
    acquire: (signal?: AbortSignal) => gateFor(kind, key, limits).acquire(signal),
    pause: (ms: number) => gateFor(kind, key, limits).pause(ms),
  };
}

/** For tests. */
export function gateCount(): number { return gates.size; }

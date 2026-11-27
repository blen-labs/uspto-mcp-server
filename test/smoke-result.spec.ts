import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { executeProblems, parseBody } from '../scripts/smoke-result.mjs';

const success = { jsonrpc: '2.0', id: 1, result: { content: [], structuredContent: { ok: true, value: 42 } } };

describe('smoke result check', () => {
  it('accepts exactly the expected successful result, in JSON or SSE', () => {
    expect(executeProblems(parseBody(JSON.stringify(success)), 1, 42)).toEqual([]);
    expect(executeProblems(parseBody(`event: message\ndata: ${JSON.stringify(success)}\n\n`), 1, 42)).toEqual([]);
  });

  it('rejects a wrong value, an error-marked result, a JSON-RPC error and another request id', () => {
    const wrong = { ...success, result: { structuredContent: { ok: true, value: 420 } } };
    const marked = { ...success, result: { isError: true, structuredContent: { ok: true, value: 42 } } };
    const failed = { ...success, result: { structuredContent: { ok: false, value: 42 } } };
    const rpcError = { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad' } };
    expect(executeProblems(wrong, 1, 42)).toEqual(['structuredContent.value is 420, expected 42']);
    expect(executeProblems(marked, 1, 42)).toEqual(['the tool result is marked isError']);
    expect(executeProblems(failed, 1, 42)).toEqual(['structuredContent.ok is not true']);
    expect(executeProblems(rpcError, 1, 42)[0]).toMatch(/^JSON-RPC error/);
    expect(executeProblems({ ...success, id: 2 }, 1, 42)).toEqual(['response id 2, expected 1']);
  });

  it('exits non-zero from the command line for anything but the expected result', () => {
    const run = (input: string) => spawnSync(process.execPath, ['scripts/smoke-result.mjs', '1', '42'], { input, encoding: 'utf8' }).status;
    expect(run(JSON.stringify(success))).toBe(0);
    expect(run(JSON.stringify({ ...success, result: { structuredContent: { ok: true, value: 420 } } }))).toBe(1);
    expect(run('not json')).toBe(1);
  });
});

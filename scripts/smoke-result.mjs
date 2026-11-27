#!/usr/bin/env node
// Decides whether a smoke-test response is the exact successful `execute` result expected, so a
// wrong value, a JSON-RPC error or an error-marked tool result fails the smoke check. Used by
// scripts/mcpb-smoke.mjs (stdio) and by CI's Docker smoke (HTTP, JSON or SSE body on stdin):
//
//   curl ... | node scripts/smoke-result.mjs <id> <expected JSON value>

/** The JSON-RPC message in an HTTP body: plain JSON, or the `data:` line of a single SSE event. */
export function parseBody(body) {
  const text = body.trim();
  if (text.startsWith('{')) return JSON.parse(text);
  const data = text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
  if (data.length !== 1) throw new Error(`expected one SSE data line, got ${data.length}`);
  return JSON.parse(data[0]);
}

/** Problems with `message` as the successful result of request `id` returning `expected`; empty when it is. */
export function executeProblems(message, id, expected) {
  if (message?.id !== id) return [`response id ${JSON.stringify(message?.id)}, expected ${id}`];
  if (message.error) return [`JSON-RPC error: ${JSON.stringify(message.error).slice(0, 300)}`];
  const result = message.result;
  const problems = [];
  if (result?.isError === true) problems.push('the tool result is marked isError');
  if (result?.structuredContent?.ok !== true) problems.push('structuredContent.ok is not true');
  if (JSON.stringify(result?.structuredContent?.value) !== JSON.stringify(expected)) {
    problems.push(`structuredContent.value is ${JSON.stringify(result?.structuredContent?.value)}, expected ${JSON.stringify(expected)}`);
  }
  return problems;
}

if (import.meta.filename === process.argv[1]) {
  const [id, expected] = [Number(process.argv[2]), JSON.parse(process.argv[3] ?? 'null')];
  let body = '';
  for await (const chunk of process.stdin) body += chunk;
  let problems;
  try {
    problems = executeProblems(parseBody(body), id, expected);
  } catch (error) {
    problems = [`unreadable response: ${error.message}`];
  }
  if (problems.length > 0) {
    console.error(`smoke: ${problems.join('; ')}\n${body.slice(0, 500)}`);
    process.exit(1);
  }
  console.log(`smoke: request ${id} returned ${JSON.stringify(expected)}`);
}

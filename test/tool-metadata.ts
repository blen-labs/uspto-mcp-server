import { expect } from 'vitest';
import type { Tool } from '@modelcontextprotocol/server';

/** Wire-level contract shared by the raw HTTP and official-client checks. */
export function expectToolMetadata(tools: Tool[]) {
  expect(tools.map(({ name, title, annotations }) => ({ name, title, annotations })))
    .toEqual([
      {
        name: 'search_api',
        title: 'Search USPTO API Documentation',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      {
        name: 'describe_schema',
        title: 'Describe USPTO API Schema',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      {
        name: 'execute',
        title: 'Query USPTO Patent and Trademark Data',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
    ]);
}

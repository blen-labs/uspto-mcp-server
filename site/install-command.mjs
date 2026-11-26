// How a client starts the server, and the Claude Code command built from it. Plain JavaScript with
// no dependencies, so site/src/lib/install.ts and the root test suite (which has no site/ install)
// read the same definition.
import { exampleKeyValues, packageName, serverName } from './product.mjs';

export const command = 'npx';
export const args = ['-y', packageName];

// One option to a line, as Claude Code's documentation writes a long command. On one line, the
// page breaks the command in the middle of a key.
export const claudeCodeCommand = [
  `claude mcp add ${serverName}`,
  ...Object.entries(exampleKeyValues).map(([name, value]) => `-e ${name}=${value}`),
  `-- ${command} ${args.join(' ')}`,
].join(' \\\n  ');

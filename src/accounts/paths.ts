/**
 * Account mode serves two MCP endpoints on one origin. MCP clients only start OAuth when an
 * endpoint answers 401, so anonymous and signed-in access need separate URLs:
 * - PUBLIC_MCP_PATH: no sign-in. USPTO sources only through the operator's shared keys
 *   (USPTO_API_KEY / USPTO_TSDR_API_KEY), if configured; otherwise calls explain how to sign in.
 * - ACCOUNT_MCP_PATH: OAuth (Google sign-in). Uses the user's own ODP and TSDR keys.
 */
export const PUBLIC_MCP_PATH = '/mcp';
export const ACCOUNT_MCP_PATH = '/mcp/account';

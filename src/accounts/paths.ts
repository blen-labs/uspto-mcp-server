/**
 * Account mode serves two MCP endpoints on one origin. MCP clients only start OAuth when an
 * endpoint answers 401, so anonymous and signed-in access need separate URLs:
 * - PUBLIC_MCP_PATH: no sign-in. Documentation tools only (search_api, describe_schema): USPTO
 *   keys are personal, so account mode never serves USPTO calls with a process-level key.
 * - ACCOUNT_MCP_PATH: OAuth (Google sign-in). Uses the user's own ODP and TSDR keys.
 */
export const PUBLIC_MCP_PATH = '/mcp';
export const ACCOUNT_MCP_PATH = '/mcp/account';

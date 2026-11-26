---
name: Bug report
about: Something is broken or misbehaving
labels: bug
---

## What happened?

<!-- One paragraph. What did you expect? What did you see instead? -->

## Reproduction

```bash
# the exact command(s) you ran
```

```ts
// if it's a sandbox issue, paste the code you passed to `execute`
```

## Environment

- Server version: <!-- the version your MCP client shows for uspto-mcp-server, or git SHA; npm view shows the newest release, not the one you run -->
- Transport: <!-- stdio | http -->
- Sandbox runner: <!-- isolate | deno | unavailable -->
- Node: <!-- node -v -->
- OS / arch: <!-- e.g. Ubuntu 22.04 x64 -->
- MCP client: <!-- Claude Desktop, custom, etc. -->

## Logs

<!-- Paste relevant log lines. Set USPTO_LOG_LEVEL=debug for more detail.
     Remove API keys first, and names or addresses from USPTO responses. -->

```text
```

> **Security issue?** Please use a GitHub Security Advisory instead — see [SECURITY.md](https://github.com/blen-labs/uspto-mcp-server/blob/main/SECURITY.md).

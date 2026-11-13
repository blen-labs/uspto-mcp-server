## What

<!-- One paragraph: the change and its motivation. Link issues. -->

## How

<!-- Implementation notes for a reviewer. Highlight non-obvious decisions. -->

## Test plan

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] If HTTP-visible: added/updated a case in `test/http-integration.spec.ts`
- [ ] If sandbox-visible: added a positive and a negative case in `test/sandbox.spec.ts` (both runners)
- [ ] If new SDK method: added an endpoint entry with a runnable example in the source's corpus (`schema/{odp,tsdr}.json`), registered it in the source factory's `methods` table, added it to `test/dispatch.spec.ts`, and ran `node scripts/gen-sdk-reference.mjs`
- [ ] If it changes upstream calls: ran `USPTO_LIVE=1 pnpm test:live` with my own key (or explained why not)
- [ ] No API keys, `.env` files, or captured USPTO responses in the diff

## Risk

<!-- Security/perf/back-compat impact. "None" is a valid answer when honest. -->

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { KEY_INFO, KeyField } from '@/components/fields';
import { Loading, Notice, Shell, SignedInAs, SignOut } from '@/components/shell';
import { api, type ClaudeLinkStatus, type KeyKind, type Keys } from '@/lib/api';
import { useLoad } from '@/lib/use-load';

function KeyCard({
  kind,
  connected,
  onChanged,
}: {
  kind: KeyKind;
  connected: boolean;
  onChanged: (notice: string) => void;
}) {
  const info = KEY_INFO[kind];
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  /** Runs a change; the server's warning, if any, replaces the success notice. */
  async function run(action: () => Promise<{ warning?: string }>, notice: string) {
    setBusy(true);
    setError(undefined);
    try {
      const result = await action();
      setApiKey('');
      onChanged(result.warning ?? notice);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {info.name}
          <Badge variant={connected ? 'default' : 'outline'}>
            {connected ? 'Key saved' : 'No key'}
          </Badge>
        </CardTitle>
        <CardDescription>
          Used for {info.covers} in your signed-in connections. It is never displayed again.
        </CardDescription>
      </CardHeader>
      <CardContent>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api('/keys', { [info.field]: apiKey }), `Key saved. USPTO accepted your ${info.name}.`);
            }}
          >
            {error && <Notice>{error}</Notice>}
            <KeyField
              kind={kind}
              label={connected ? 'Replace key' : info.name}
              required
              value={apiKey}
              onChange={setApiKey}
            />
            <div className="flex flex-wrap gap-3">
              <Button type="submit" disabled={busy}>
                Check and save
              </Button>
              {connected && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () => api('/keys/delete', { kind }),
                      `${info.name} removed. Your other key, if any, keeps working.`,
                    )
                  }
                >
                  Remove key
                </Button>
              )}
            </div>
          </form>
      </CardContent>
    </Card>
  );
}

/** What the server's link callback reports (?claude=…), as fixed text. */
const CLAUDE_RESULTS: Record<string, { kind: 'success' | 'error'; text: string }> = {
  linked: { kind: 'success', text: 'Your Claude organization is linked. Claude usage here is billed to it.' },
  denied: { kind: 'error', text: 'Linking was cancelled. Nothing changed.' },
  already_linked: { kind: 'error', text: 'That Claude organization is already linked to another account here. Unlink it there first.' },
  expired: { kind: 'error', text: 'That link request expired or was started in another browser. Start again.' },
  signin: { kind: 'error', text: 'Sign in, then start linking again.' },
  failed: { kind: 'error', text: 'Claude could not complete the link. Try again later.' },
};

function ClaudeCard({ status, onChanged }: { status: ClaudeLinkStatus; onChanged: (notice: string) => void }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // Coming back with the browser's Back button restores this page as it was left: re-enable it.
  useEffect(() => {
    const restored = (e: PageTransitionEvent) => { if (e.persisted) setBusy(false); };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, []);
  async function link() {
    setBusy(true);
    setError(undefined);
    try {
      const { url } = await api<{ url: string }>('/claude/link', {});
      window.location.assign(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      setBusy(false);
    }
  }
  async function unlink() {
    setBusy(true);
    setError(undefined);
    try {
      await api('/claude/unlink', {});
      onChanged('Your Claude organization is unlinked.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Claude billing
          <Badge variant={status.linked ? 'default' : 'outline'}>{status.linked ? 'Linked' : 'Not linked'}</Badge>
        </CardTitle>
        <CardDescription>
          Link your own Claude Platform organization so Claude usage on this site is billed to it. A member of that
          organization with the Admin or Billing role approves the link on claude.com and sets a monthly spend limit.
          You can unlink here or in the Claude Console at any time.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error && <Notice>{error}</Notice>}
        <div className="flex flex-wrap gap-3">
          {status.linked ? (
            <Button type="button" variant="outline" disabled={busy} onClick={() => void unlink()}>
              Unlink
            </Button>
          ) : (
            <Button type="button" disabled={busy} onClick={() => void link()}>
              Link Claude organization
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function Account() {
  const { data, error, reload } = useLoad(() => api<Keys>('/account'), '/account');
  const claude = useLoad(() => api<ClaudeLinkStatus>('/claude'), '/account');
  // The link callback returns here with ?claude=<result>; show it once, then drop it from the URL.
  const [linkResult] = useState(() => CLAUDE_RESULTS[new URLSearchParams(window.location.search).get('claude') ?? '']);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('claude')) window.history.replaceState(null, '', '/account');
  }, []);
  const [notice, setNotice] = useState<string>();
  if (error)
    return (
      <Shell title="Your account">
        <Notice>{error}</Notice>
      </Shell>
    );
  if (!data) return <Loading />;
  return (
    <Shell
      wide
      title="Your account"
      description={<SignedInAs email={data.email} />}
      action={<SignOut then="/" />}
    >
      {notice && <Notice kind="success">{notice}</Notice>}
      {!notice && linkResult && <Notice kind={linkResult.kind}>{linkResult.text}</Notice>}
      {(['odp', 'tsdr'] as const).map((kind) => (
        <KeyCard
          key={kind}
          kind={kind}
          connected={data.keys[kind].connected}
          onChanged={(message) => {
            setNotice(message);
            reload();
          }}
        />
      ))}
      {claude.data?.enabled && (
        <ClaudeCard
          status={claude.data}
          onChanged={(message) => {
            setNotice(message);
            claude.reload();
          }}
        />
      )}
    </Shell>
  );
}

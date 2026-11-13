import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { KEY_INFO, KeyField } from '@/components/fields';
import { Loading, Notice, Shell, SignedInAs, SignOut } from '@/components/shell';
import { api, type Connection, type Keys } from '@/lib/api';
import { useFlow } from '@/lib/flow';
import { useLoad } from '@/lib/use-load';

/** Better Auth's post-login step: save the USPTO API keys this connection uses. */
export function Connect() {
  const { oauthQuery } = useFlow();
  const { data, error: loadError } = useLoad(
    () => api<Connection & Keys>(`/connect?${new URLSearchParams({ oauth_query: oauthQuery })}`),
    `${window.location.pathname}${window.location.search}`,
  );
  const [apiKey, setApiKey] = useState('');
  const [tsdrApiKey, setTsdrApiKey] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function send(decision: 'continue' | 'deny') {
    setBusy(true);
    setError(undefined);
    try {
      const { url } = await api<{ url: string }>('/connect', {
        oauth_query: oauthQuery,
        decision,
        ...(apiKey ? { apiKey } : {}),
        ...(tsdrApiKey ? { tsdrApiKey } : {}),
      });
      window.location.assign(url);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    }
  }
  if (loadError)
    return (
      <Shell title="Unable to continue">
        <Notice>{loadError}</Notice>
      </Shell>
    );
  if (!data) return <Loading />;
  return (
    <Shell
      title={`Connect ${data.client}`}
      description={<SignedInAs email={data.email} />}
      action={<SignOut then={`/sign-in?${oauthQuery}`} />}
    >
      {error && <Notice>{error}</Notice>}
      <form
        className="grid gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void send('continue');
        }}
      >
        <div className="grid gap-3">
          <h2 className="flex items-center gap-2 font-medium">
            <KeyRound className="size-4" />
            Your USPTO API keys
          </h2>
          <p className="text-muted-foreground text-sm">
            USPTO issues API keys to individuals, so this connection uses yours. Keys stay encrypted on
            this server and are never shown to your AI assistant.
          </p>
          <KeyField
            kind="odp"
            label={data.keys.odp.connected ? `Replace your ${KEY_INFO.odp.name} (saved)` : KEY_INFO.odp.name}
            required={false}
            value={apiKey}
            onChange={setApiKey}
          />
          <KeyField
            kind="tsdr"
            label={data.keys.tsdr.connected ? `Replace your ${KEY_INFO.tsdr.name} (saved)` : `${KEY_INFO.tsdr.name} (optional)`}
            required={false}
            value={tsdrApiKey}
            onChange={setTsdrApiKey}
          />
          <p className="text-muted-foreground text-xs">
            Leave a field empty to keep the saved key, or to skip that source for now.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={busy}>
            Continue
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => send('deny')}>
            Cancel
          </Button>
        </div>
      </form>
    </Shell>
  );
}

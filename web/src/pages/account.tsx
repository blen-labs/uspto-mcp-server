import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { KEY_INFO, KeyField } from '@/components/fields';
import { Loading, Notice, Shell, SignedInAs, SignOut } from '@/components/shell';
import { api, type KeyKind, type Keys } from '@/lib/api';
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

export function Account() {
  const { data, error, reload } = useLoad(() => api<Keys>('/account'), '/account');
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
    </Shell>
  );
}

import type * as React from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** A labeled input with optional help text. */
export function Field({
  id,
  label,
  help,
  ...props
}: React.ComponentProps<typeof Input> & {
  id: string;
  label: React.ReactNode;
  help?: React.ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} aria-describedby={help ? `${id}-help` : undefined} {...props} />
      {help && (
        <p id={`${id}-help`} className="text-muted-foreground text-xs">
          {help}
        </p>
      )}
    </div>
  );
}

/** A link to another site, opened in a new tab. */
function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-4">
      {children}
    </a>
  );
}

/** Where each USPTO key comes from, and which field name the portal API expects. */
export const KEY_INFO = {
  odp: {
    name: 'Open Data Portal API key',
    field: 'apiKey',
    covers: 'patents, PTAB, petitions, office actions, bulk datasets',
    help: (
      <>
        Free: sign in at{' '}
        <ExternalLink href="https://data.uspto.gov/myodp">data.uspto.gov/myodp</ExternalLink> with a
        USPTO.gov account that has multi-factor authentication and is linked to ID.me, then open
        Manage API Key (
        <ExternalLink href="https://data.uspto.gov/support/universal-registration">how to register</ExternalLink>
        ). If your key was deactivated, complete your profile and click Activate API Key there.
        Saving runs one small request to check it.
      </>
    ),
  },
  tsdr: {
    name: 'TSDR API key',
    field: 'tsdrApiKey',
    covers: 'trademark status and documents',
    help: (
      <>
        Optional, separate from the ODP key. Get it from the{' '}
        <ExternalLink href="https://account.uspto.gov/api-manager">USPTO API Key Manager</ExternalLink>.
        Saving runs one small request to check it.
      </>
    ),
  },
} as const;

/** A USPTO API key input, used on the connect page and the account page. */
export function KeyField({
  kind,
  label,
  required,
  value,
  onChange,
}: {
  kind: keyof typeof KEY_INFO;
  label: string;
  required: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field
      id={KEY_INFO[kind].field}
      label={label}
      type="password"
      autoComplete="off"
      minLength={16}
      maxLength={128}
      pattern="[A-Za-z0-9._\-]{16,128}"
      required={required}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      help={KEY_INFO[kind].help}
    />
  );
}

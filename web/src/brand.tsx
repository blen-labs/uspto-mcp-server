import type { Brand } from '@/components/kit/brand';

export const brand: Brand = {
  name: 'Patents & Trademarks MCP',
  tagline: 'U.S. patent and trademark data in your AI assistant',
  summary:
    'Search patent applications, PTAB proceedings, petitions, office actions and trademark status from the official USPTO APIs, in Claude, ChatGPT, Cursor and other MCP clients.',
  repoUrl: 'https://github.com/blen-labs/uspto-mcp-server',
  docsUrl: '/docs/',
  license: 'Apache-2.0',
  disclaimer: 'Independent open-source project; not affiliated with or endorsed by the USPTO.',
  accountPurpose: 'manage your USPTO API keys',
  connect: {
    signInStep: (
      <>
        Sign in with Google, then add your free USPTO Open Data Portal key (and, for trademarks, a TSDR key).
        Keys are encrypted and used only by this server; your assistant never sees them.{' '}
        <a href="/docs/keys/" className="text-foreground underline underline-offset-4">
          How to get the keys
        </a>
        .
      </>
    ),
    publicNote:
      'Browse the API documentation tools without signing in. Running queries needs your own USPTO key, so use the server URL above for that.',
    guidesHref: '/docs/connect/',
  },
  examples: [
    { title: 'Prosecution history', prompt: 'Summarize the prosecution history of application 16/123,456, including every office action.' },
    { title: 'PTAB challenges', prompt: 'Which inter partes reviews were filed against patents assigned to Acme Corp since 2023, and how did they end?' },
    { title: 'Portfolio overview', prompt: 'List the patents granted to Example Inc. in 2025, grouped by CPC class.' },
    { title: 'Trademark status', prompt: 'What is the current status of trademark serial number 97123456, and what is the next deadline?' },
    { title: 'Office action trends', prompt: 'How often were §101 rejections issued in art unit 3689 over the last two years?' },
    { title: 'Petitions', prompt: 'Find petition decisions about revival of abandoned applications in 2025.' },
  ],
  sources: [
    {
      name: 'USPTO Open Data Portal',
      description: 'Patent file wrappers, PTAB trials, appeals and interferences, petition decisions, office actions and the bulk dataset catalog.',
      href: '/docs/reference/sdk/',
    },
    {
      name: 'Trademark Status & Document Retrieval (TSDR)',
      description: 'Trademark case status, prosecution history and documents by serial or registration number.',
      href: '/docs/reference/sdk/',
    },
  ],
  howItWorks: [
    {
      title: 'Three tools',
      body: 'Your assistant searches the API reference, reads field definitions, and writes a short program instead of calling dozens of narrow tools.',
    },
    {
      title: 'A locked-down sandbox',
      body: 'Programs run without network, filesystem or environment access. They can only call the USPTO methods this server exposes.',
    },
    {
      title: 'Your own keys',
      body: 'USPTO keys are personal. Yours are encrypted at rest, used only for your requests, and paced to USPTO’s rate limits.',
    },
  ],
  howItWorksHref: '/docs/how-it-works/',
};

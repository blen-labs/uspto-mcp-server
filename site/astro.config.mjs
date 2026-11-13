import { unified } from '@astrojs/markdown-remark';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { readFileSync } from 'node:fs';
import starlightLinksValidator from 'starlight-links-validator';
import starlightLlmsTxt from 'starlight-llms-txt';
import { groups, pages } from './src/lib/pages.mjs';

// GitHub Pages serves a project site under the repository name. To move to a custom domain,
// set `site` to it and `base` to '/', and take the base out of the three hero links in
// index.mdx and out of scripts/check-links.mjs. Every other link is root-absolute.
const site = 'https://blen-labs.github.io';
const base = '/uspto-mcp-server';

const repo = 'https://github.com/blen-labs/uspto-mcp-server';

// Astro adds `base` to its own assets and Starlight adds it to the sidebar, but neither touches
// a link written inside a page. This adds it to root-absolute links in Markdown and in MDX
// components, so pages can link to `/connect/` wherever the site is served.
function rehypeBase() {
  const prefix = (value) =>
    typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? base + value : value;
  const visit = (node) => {
    if (node.type === 'element' && node.tagName === 'a' && node.properties?.href !== undefined) {
      node.properties.href = prefix(node.properties.href);
    }
    if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
      for (const attribute of node.attributes ?? []) {
        if (attribute.name === 'href') attribute.value = prefix(attribute.value);
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  return visit;
}

// A page's description from its frontmatter, for the page list in llms.txt. The SDK reference
// is a .md file that `pnpm sync` writes; every other page is .mdx.
function descriptionOf(slug) {
  for (const extension of ['mdx', 'md']) {
    try {
      const source = readFileSync(new URL(`./src/content/docs/${slug}.${extension}`, import.meta.url), 'utf8');
      return /^description: (.+)$/m.exec(source)?.[1];
    } catch {
      // Not this extension.
    }
  }
}

export default defineConfig({
  site,
  base,
  markdown: { processor: unified({ rehypePlugins: [rehypeBase] }) },
  integrations: [
    starlight({
      title: 'Patents & Trademarks MCP',
      description:
        'Connect an AI assistant to the USPTO Open Data Portal and TSDR APIs with the Patents & Trademarks MCP server.',
      favicon: '/favicon.svg',
      logo: { src: './src/assets/blen-logo-red.svg', alt: 'BLEN' },
      // Geist is BLEN's typeface. The rest of the theme is Starlight's default.
      customCss: ['@fontsource-variable/geist', '@fontsource-variable/geist-mono', './src/styles/custom.css'],
      expressiveCode: {
        themes: ['github-dark', 'github-light'],
        defaultProps: {
          // A line that is still too long wraps, so no block scrolls sideways.
          wrap: true,
          // Shell commands get the same plain frame as code, not a terminal window.
          overridesByLang: { 'bash,sh,shell,zsh': { frame: 'code' } },
        },
        // A plain bordered frame. A file name is small gray text over a line, not an editor tab.
        // The colors are variables that custom.css sets for each theme.
        styleOverrides: {
          borderRadius: '0.625rem',
          borderColor: 'var(--sl-color-gray-5)',
          codeBackground: 'var(--code-surface)',
          codeFontSize: '0.8125rem',
          codeLineHeight: '1.7',
          codePaddingBlock: '1rem',
          codePaddingInline: '1.25rem',
          uiFontFamily: 'var(--sl-font-mono)',
          uiFontSize: '0.75rem',
          frames: {
            shadowColor: 'transparent',
            frameBoxShadowCssValue: 'none',
            editorTabBarBackground: 'var(--code-surface)',
            editorTabBarBorderColor: 'var(--sl-color-gray-5)',
            editorTabBarBorderBottomColor: 'var(--sl-color-gray-5)',
            // Transparent, so the line below the file name runs the full width of the frame.
            editorActiveTabBackground: 'transparent',
            editorActiveTabForeground: 'var(--sl-color-gray-3)',
            editorActiveTabBorderColor: 'transparent',
            editorActiveTabIndicatorTopColor: 'transparent',
            editorActiveTabIndicatorBottomColor: 'transparent',
          },
        },
      },
      social: [{ icon: 'github', label: 'GitHub', href: repo }],
      editLink: { baseUrl: `${repo}/edit/main/site/` },
      head: [
        // The picture that a chat app or a social site shows with a link to the site.
        { tag: 'meta', attrs: { property: 'og:image', content: `${site}${base}/og.png` } },
        {
          tag: 'meta',
          attrs: {
            property: 'og:image:alt',
            content: 'Patents & Trademarks MCP: ask your AI assistant about U.S. patents and trademarks.',
          },
        },
      ],
      components: {
        // Adds the page actions: copy the page as Markdown, view it, or open it in an assistant.
        PageTitle: './src/components/PageTitle.astro',
        // Adds the links to llms.txt, llms-full.txt, and the page's Markdown copy.
        Footer: './src/components/Footer.astro',
      },
      // Adds each page's Markdown link to its <head>.
      routeMiddleware: './src/routeData.ts',
      sidebar: groups.map((group) => ({
        label: group.label,
        items: group.pages.map(({ label, slug }) => ({ label, slug })),
      })),
      plugins: [
        // llms.txt and the Markdown copies are files, not pages, so the validator cannot see them.
        starlightLinksValidator({ exclude: ['/llms.txt', '/llms-full.txt'] }),
        starlightLlmsTxt({
          details: [
            'The server runs on the user\'s computer and needs the user\'s own USPTO API keys.',
            'It has three tools: `search_api`, `describe_schema`, and `execute`.',
            'Each page below is also available on its own, as Markdown.',
          ].join('\n'),
          // One document set for each page: its Markdown copy, which the page actions link to.
          customSets: pages.map(({ label, slug }) => ({ label, paths: [slug], description: descriptionOf(slug) })),
          // The link icon beside each heading is noise in Markdown.
          customSelectors: { all: ['.sl-anchor-link'] },
          // The sets use the plugin's compact output. A page's Markdown copy keeps its notes and
          // its line breaks, which the compact output would remove.
          minify: { note: false, tip: false, details: false, whitespace: false },
          optionalLinks: [
            { label: 'Source code', url: repo, description: 'the server, its tests, and the long guides' },
            {
              label: 'npm package',
              url: 'https://www.npmjs.com/package/@blen/uspto-mcp-server',
              description: 'the published server',
            },
          ],
        }),
      ],
    }),
  ],
});

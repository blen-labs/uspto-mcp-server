import { useEffect, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { SiteFooter } from '@/components/kit/site-footer';
import { SiteHeader } from '@/components/kit/site-header';
import { useDocumentTitle } from '@/components/kit/use-document-title';

/**
 * Every page: a skip link, the site header, one `main` landmark, and the footer. Sets the tab
 * title. After a client-side navigation, focus moves to the page's heading so keyboard and
 * screen-reader users start at the new content (the first load keeps the browser default).
 */
export function Page({ title, children }: { title?: string; children: ReactNode }) {
  useDocumentTitle(title);
  const location = useLocation();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    document.querySelector<HTMLElement>('main h1')?.focus();
  }, [location.pathname]);
  return (
    <div className="flex min-h-svh flex-col">
      <a
        href="#main"
        className="bg-background text-foreground sr-only z-50 rounded-md px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to main content
      </a>
      <SiteHeader />
      <main id="main" tabIndex={-1} className="flex-1 outline-none">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}

import Link from "next/link";
import type { ReactNode } from "react";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-root">
      <header className="site-header">
        <div className="site-header-inner">
          <Link href="/" className="brand">
            <span className="brand-mark" aria-hidden />
            <span className="brand-text">VoteMatch</span>
          </Link>
          <nav className="site-nav" aria-label="Main">
            <Link href="/">Home</Link>
            <Link href="/reports">Reports</Link>
            <Link href="/review">Review</Link>
          </nav>
        </div>
      </header>
      <div className="site-body">{children}</div>
    </div>
  );
}

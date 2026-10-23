// A collapsible form section: a header button (title plus a one-line summary of
// the current state) that shows or hides the fields. Collapsed by default;
// `forceOpen` keeps it open while something inside needs attention, so a hidden
// error can never block the form unseen.

import { useId, useState, type ReactNode } from "react";

export interface DisclosureProps {
  testId: string;
  title: string;
  /** What the section holds right now, shown next to the title while collapsed. */
  summary?: string;
  forceOpen?: boolean;
  children: ReactNode;
}

export function Disclosure({ testId, title, summary, forceOpen = false, children }: DisclosureProps) {
  const [userOpen, setUserOpen] = useState(false);
  const open = userOpen || forceOpen;
  const panelId = useId();
  return (
    <section className="disclosure" data-testid={testId} data-open={open}>
      <button
        type="button"
        className="disclosure-head"
        aria-expanded={open}
        aria-controls={panelId}
        disabled={forceOpen}
        onClick={() => setUserOpen((value) => !value)}
        data-testid={`${testId}-toggle`}
      >
        <span className="disclosure-chevron" aria-hidden="true">›</span>
        <span className="disclosure-title">{title}</span>
        {summary && <span className="disclosure-summary">{summary}</span>}
      </button>
      <div id={panelId} className="disclosure-body" hidden={!open}>{children}</div>
    </section>
  );
}

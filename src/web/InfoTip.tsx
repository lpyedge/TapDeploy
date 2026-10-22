import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

// Secondary help behind an "i" button: shown on hover, keyboard focus or tap,
// closed with Escape or by tapping elsewhere. The text stays in the DOM so
// assistive tech reads it through aria-describedby.
export function InfoTip({ children, label = "More information" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      const escape = event instanceof KeyboardEvent && event.key === "Escape";
      if (escape || (!(event instanceof KeyboardEvent) && !root.current?.contains(event.target as Node))) {
        setOpen(false);
        if (escape && root.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      }
    };
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("pointerdown", close);
    };
  }, [open]);

  return (
    <span className="infotip" ref={root} data-open={open}>
      <button type="button" className="infotip-btn" aria-label={label} aria-expanded={open} aria-describedby={id} onClick={() => setOpen((v) => !v)}>
        i
      </button>
      <span role="tooltip" id={id} className="infotip-pop">
        {children}
      </span>
    </span>
  );
}

import type { ReactNode } from "react";

/** No separate Connect screen (sign-in starts from the config step); review,
 * progress and result live on the Deploy step. */
const STEPS = ["Config", "Release", "Configure", "Deploy"] as const;

// Same-origin hashed asset (the favicon in index.html is the same file).
const LOGO_URL = new URL("./assets/logo.png", import.meta.url).href;

function Stepper({ current, steps }: { current: number; steps: readonly string[] }) {
  return (
    <nav aria-label="Progress" className="stepper" data-testid="stepper">
      <p className="stepper-compact" aria-hidden="true">
        Step {current + 1} of {steps.length} · {steps[current]}
      </p>
      <ol>
        {steps.map((name, index) => (
          <li key={name} data-state={index < current ? "done" : index === current ? "current" : "todo"} aria-current={index === current ? "step" : undefined}>
            <span className="stepper-dot">{index < current ? "✓" : index + 1}</span>
            <span className="stepper-name">{name}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

// Page frame shared by every step: brand + optional account control, the
// progress stepper and the notice line. Step content is the children.
export function Shell({ step, account, notice, children }: { step: number; account?: ReactNode; notice?: string | null; children: ReactNode }) {
  return (
    <main className="page">
      <header className="topbar">
        <div className="brand">
          <img src={LOGO_URL} alt="" width="28" height="28" />
          <h1>TapDeploy</h1>
        </div>
        {account}
      </header>
      <Stepper current={step} steps={STEPS} />
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {children}
    </main>
  );
}

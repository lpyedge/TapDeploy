import type { ReactNode } from "react";

/** No separate Connect screen (sign-in starts from the config step); review,
 * progress and result live on the Deploy step. */
const STEPS = ["Config", "Release", "Configure", "Deploy"] as const;

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
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path fill="currentColor" d="M17.5 19H7a5 5 0 1 1 .9-9.92A6 6 0 0 1 19.4 11 4 4 0 0 1 17.5 19z" />
          </svg>
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

import type { AccountSummary } from "./api.js";

interface AccountBarProps {
  accountId: string;
  accounts: AccountSummary[];
  onAccount: (id: string) => void;
}

export function AccountBar({ accountId, accounts, onAccount }: AccountBarProps) {
  const missing = accountId === "" && accounts.length > 0;
  return (
    <label className="account-control" htmlFor="account">
      <span>Account{missing ? <span className="req"> *</span> : null}</span>
      <select id="account" value={accountId} aria-invalid={missing} onChange={(e) => onAccount(e.target.value)} data-testid="account-select">
        <option value="">{accounts.length === 0 ? "No accounts available" : "Select account…"}</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </label>
  );
}

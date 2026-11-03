// The Configure step's form state: every value the operator can change, and the
// handlers that keep related values consistent (switching between a new install
// and an upgrade starts the name and secret choices over; unticking a secret
// drops the value typed for it). Nothing here is persisted or sealed.

import { useState } from "react";
import type { InputMode } from "../manifest/input-validation.js";
import type { UnitDomainDraft } from "./domain-choices.js";

export function useConfigureForm() {
  const [mode, setMode] = useState<InputMode>("install");
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [nameValues, setNameValues] = useState<Record<string, string>>({});
  const [replacedSecrets, setReplacedSecrets] = useState<string[]>([]);
  const [domainDrafts, setDomainDrafts] = useState<Record<string, UnitDomainDraft>>({});
  const [hyperdriveChoices, setHyperdriveChoices] = useState<Record<string, Record<string, string>>>({});
  // Secret values (typed in Configure) live in memory only, until the deploy steps that send them.
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});

  return {
    mode,
    inputValues,
    nameValues,
    replacedSecrets,
    domainDrafts,
    hyperdriveChoices,
    secretValues,
    setInput: (key: string, value: string) => setInputValues((prev) => ({ ...prev, [key]: value })),
    setName: (key: string, value: string) => setNameValues((prev) => ({ ...prev, [key]: value })),
    setDraft: (unitId: string, draft: UnitDomainDraft) => setDomainDrafts((prev) => ({ ...prev, [unitId]: draft })),
    setHyperdriveChoice: (unitId: string, binding: string, config: string) =>
      setHyperdriveChoices((prev) => ({ ...prev, [unitId]: { ...(prev[unitId] ?? {}), [binding]: config } })),
    setSecret: (name: string, value: string) => setSecretValues((prev) => ({ ...prev, [name]: value })),
    /** Install names and upgrade picks mean different things: switching starts them over. */
    changeMode: (next: InputMode) => {
      setMode(next);
      setNameValues({});
      setReplacedSecrets([]);
      setSecretValues({});
    },
    replaceSecret: (key: string, replace: boolean) => {
      setReplacedSecrets((prev) => (replace ? [...prev.filter((name) => name !== key), key] : prev.filter((name) => name !== key)));
      if (!replace) setSecretValues((prev) => Object.fromEntries(Object.entries(prev).filter(([name]) => name !== key)));
    },
    clearSecrets: () => setSecretValues({}),
    /** A verified release: its names are the suggestions again, and its Worker name prefills the field. */
    startRelease: (workerName: string | undefined) => {
      setNameValues({});
      if (workerName) setInputValues((prev) => (prev.workerName === undefined ? { ...prev, workerName } : prev));
    },
    reset: () => {
      setMode("install");
      setInputValues({});
      setNameValues({});
      setReplacedSecrets([]);
      setDomainDrafts({});
      setHyperdriveChoices({});
      setSecretValues({});
    },
  };
}

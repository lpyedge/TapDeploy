// Loads account facts once per key. `key` is null while nothing is wanted yet
// (another step, no account chosen); a new key loads again and a result for a
// key that is no longer current is dropped. A failed load is reported, never
// thrown, so a form can degrade to manual entry instead of blocking.

import { useEffect, useRef, useState } from "react";
import { safeErrorMessage } from "./deploy-shared.js";

export interface Loaded<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export function useLoaded<T>(key: string | null, load: () => Promise<T>): Loaded<T> {
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string | null }>({ key: null, data: null, error: null });
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (key === null || state.key === key) return;
    let cancelled = false;
    loadRef.current().then(
      (data) => { if (!cancelled) setState({ key, data, error: null }); },
      (error: unknown) => { if (!cancelled) setState({ key, data: null, error: safeErrorMessage(error) }); },
    );
    return () => { cancelled = true; };
  }, [key, state.key]);
  // A paused query retains its result for review/replanning. An active query
  // must never expose another account or Worker's facts while it loads.
  const current = key === null || state.key === key;
  return { data: current ? state.data : null, loading: !current, error: current ? state.error : null };
}

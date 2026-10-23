// The address records of every zone the operator picked for a domain, read once
// per zone. A zone that cannot be read counts as having no records: the server
// re-verifies any hostname before it writes.

import { useEffect, useState } from "react";
import { getDomains } from "./api.js";
import type { RecordsByZone } from "./domain-choices.js";

export function useZoneRecords(csrf: string, accountId: string, zones: readonly string[]): RecordsByZone {
  const [recordsByZone, setRecordsByZone] = useState<Record<string, RecordsByZone[string]>>({});
  const wanted = zones.join(",");
  useEffect(() => {
    const missing = zones.filter((zone) => !(zone in recordsByZone));
    if (missing.length === 0 || !csrf || !accountId) return;
    for (const zone of missing) {
      void getDomains(csrf, accountId, { zone })
        .then((envelope) => setRecordsByZone((prev) => ({ ...prev, [zone]: envelope.records ?? [] })))
        .catch(() => setRecordsByZone((prev) => ({ ...prev, [zone]: [] })));
    }
  }, [wanted, csrf, accountId]);
  return recordsByZone;
}

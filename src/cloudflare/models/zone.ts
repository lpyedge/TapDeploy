

// The installer consumes only the identity it needs (id + name). Trailing
// fields from the provider are ignored so a forward-compatible response does
// not break the typed client.
export interface ZoneSummary {
  id: string;
  name: string;
}

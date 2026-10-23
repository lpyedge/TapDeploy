// A small rotating ring for "waiting for the server": shown inside a button
// whose action takes a moment, so the page never looks stuck.

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

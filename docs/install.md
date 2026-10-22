# Install guide (end users, browser only)

You need a browser and a Cloudflare account. No Node, Wrangler, Git, or
GitHub account. Nothing is installed on your machine; the installer deploys
into **your** Cloudflare account through a session you authorize.

## 1. Open the installer link

Your publisher gives you a link carrying the app config (`?config=https://…`),
or the config itself to paste. The installer never invents steps, inputs, or
targets beyond what the config and the release declare.

## 2. Sign in to Cloudflare (once)

Loading the config takes you straight to Cloudflare's consent page, which lists
the exact permissions derived from that config. The token stays in a
short-lived sealed HttpOnly cookie on the installer server; page JavaScript
never sees it. There is no second login later in the flow; if the session
expires, the installer sends you back to Cloudflare for the same config and you
re-confirm the plan.

## 3. Pick the release ZIP

Either download the published HTTPS ZIP through the page, or choose a local
`.zip` file you already trust. Both arrive at the same server verification:
the server — not your browser — checks every byte and issues a release proof.
A tampered or wrong-format ZIP stops here with a typed error, before anything
touches Cloudflare.

## 4. Configure

Choose New or Upgrade and, when the app has a website (a Worker or a Pages
site), optionally bind one of your own domains: pick the domain and type a
subdomain (empty = the domain itself). If that address already serves
something, you are asked to confirm that it may stop working there. On
Upgrade the addresses bound today are listed; untick one to unbind it (also
confirmed). If the app connects to a database through Hyperdrive, pick your
Hyperdrive configuration here.

## 5. Review the plan

You see exactly what will happen, per unit: which Workers deploy, which
buckets/databases/namespaces/queues get created, what it may cost, and what
is unsupported (unsupported items block the whole plan — nothing is silently
skipped). Billable operations need your explicit confirmation checkbox.

## 6. Confirm and watch it deploy

Steps run one per request, in dependency order, each verified against
Cloudflare before the next starts:

- Every action shows `pending → running → done (verified)` or a plain
  waiting/error reason. Only approved work ever appears.
- If something stops, completed work **stays live** — there is no automatic
  rollback or delete. The result names the exact stopped unit/phase and how
  many receipts were sealed before the stop.
- Success is shown only for verified outcomes: a Worker version proven
  active, a Pages deployment at terminal `success`, created resources read
  back by identity. A resource-only install shows success with no website
  address — because there is none.

## 7. Afterward

- The deployment address (when there is one) is a provider-read
  `*.workers.dev` / `*.pages.dev` URL, never a guess. A custom domain you
  bound may take a few minutes until its certificate is issued.
- Closing the tab stops the flow; nothing continues in the background.
- Secrets you entered are never shown again and never leave the sealed
  server contexts.

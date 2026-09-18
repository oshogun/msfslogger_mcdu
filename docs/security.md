# Security

## Threat model, in brief

The msfslogger Windows client is a local desktop app with exactly one secret
(the ingest token) and exactly one remote host it talks to (the msfslogger
server configured in `serverUrl`). It runs on the user's own machine, is not
multi-user, and has no server-side component of its own — the msfslogger
server is a separate project. The practical risks in scope are: the ingest
token leaking to another host, another process on the same machine, a log, or
the webview; the client being tricked into sending data somewhere other than
the configured server; and TLS verification being silently weakened. Physical
or OS-level compromise of the user's own machine is out of scope, as is the
msfslogger server's own security, which this client has no control over.

## Token storage

`ingestToken` is stored in plaintext in `config.json`
(`%APPDATA%\msfslogger\config.json`) — there is no OS keychain integration.
The client's protection is that the token, once loaded, is never re-emitted:
every config snapshot that can reach the webview or a log has it stripped and
replaced with a boolean `tokenSet`, and it is never written anywhere else on
disk.

## Redaction layers

The token is scrubbed at every boundary it could otherwise cross:

- **Sidecar** (`config.ts` `redact()`, `datalink-model.ts` `scrubToken()`):
  `redact()` strips `ingestToken` from any `EffectiveConfig` before it can
  cross to the shell — this is a type-level guarantee, not just a runtime
  check (`StatusMessage.config` is typed as `RedactedConfig | null`, which has
  no `ingestToken` field at all). `scrubToken()` replaces every occurrence of
  the live token (8+ characters) with `[REDACTED]` in any string the server
  sends back — thread bodies, canned labels, WX text, loadsheet fields,
  prefile labels, clearance route/ICAO. A server `code` value is dropped the
  same way if it contains the token. The server's free-text `error` field is
  never read at all, by design, so there's nothing to scrub it from.
- **Shell** (`config.rs` `redact_text()`): every `eprintln!` log line and every
  decoded sidecar message is string-replaced for the remembered token (and its
  JSON-escaped form) before it's cached or emitted to the webview. A recursive
  walk special-cases known public string fields (`type`, `state`, `protocol`,
  `serverUrl`, ...) so a short token substring can't accidentally eat a
  protocol keyword.
- **Webview**: never sees the raw token under any code path. `config_get` and
  every status/datalink push carry only `tokenSet`.
- **CDU**: the NETWORK page's `ingestToken` field is never redisplayed — it
  renders as a fixed mask (`••••••••` / `□□□□□□□□`), never the stored value,
  and the field is masked with `•` while the user is typing a new one.

## Where the token travels

The token is sent only in the `x-ingest-token` request header, on every
ingest and datalink request that carries it at all (the reachability probe,
`GET /api/status`, is the one exception — it sets no `x-ingest-token` or any
other app-set header, so it never carries the token) — never in a query
string, a cookie, or a request body. It is never placed in argv or an
environment variable: the shell spawns the sidecar with
`node <entry> --config <path>` and an otherwise unmodified environment, so the
token reaches the sidecar only by that process reading `config.json` itself.

## The SayIntentions API key: a second secret this client never touches

The msfslogger server's optional SayIntentions.AI integration holds a second
secret — the pilot's SayIntentions API key — entirely on the server side.
This is a deliberate, permanent boundary, not a current limitation:

- The CDU never sees, collects, types or displays the key, in any form. The
  server's own read route can answer with a masked form
  (`sayintentions_api_key_masked`, e.g. `"si_1…9f2c"`) alongside the boolean
  `sayintentions_api_key_set`, but this client takes only the boolean —
  `DL-SI` renders `KEY ON FILE` / `NO KEY ON FILE` and nothing more specific.
  The masked value is never requested, never projected into any result shape,
  never logged and never reaches the webview.
- **The key-write route, `PUT /api/settings/sayintentions`, is intentionally
  excluded from the `x-ingest-token` scope** — permanently, by the server's
  own design, and confirmed as such by the peer session that shipped it. It
  stays a web-UI-only action on the server's Prefiles page. This client's
  ingest token, however capable, cannot write or change that key: there is no
  code path in the sidecar, the shell or the CDU that calls, or could call,
  that route. A CDU that finds no key configured points the operator at the
  web app rather than offering a field to fill in.

See [api](api.md) for the token-scoped routes SayIntentions does use, and
[cdu-reference](cdu-reference.md) for the exact CDU text.

## TLS

TLS verification is never disabled. A `certPath` in the config file gives an
undici `Agent` a custom CA (for a server behind a self-signed certificate) —
it never turns off hostname or chain verification, and both the ingest and
datalink HTTP clients share the same dispatcher. Setting `certPath` trusts
that CA *in place of* the system roots for requests to `serverUrl`, not in
addition to them: Node's `tls` `ca` option replaces the default trust store
rather than extending it.

An unreadable `certPath` makes the config invalid at load time
(`CONFIG INVALID`, naming the field), so nothing is sent — this fails closed,
and matches [configuration](configuration.md)'s "must be readable if set."
The only case that falls back to system trust with a logged warning is a
`certPath` file that was readable when the config loaded but has since
disappeared from disk; a request made after that fails as a certificate
error against system trust, rather than silently succeeding or hanging.

## Webview CSP and capabilities

The webview's CSP (`default-src 'self'; script-src 'self'; style-src 'self'
'unsafe-inline'; img-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost`)
grants no remote origin at all — the CDU panel cannot reach the msfslogger
server, or anywhere else, even if a page tried to. All network I/O is the
sidecar's job, entirely outside the webview's CSP jurisdiction.

The one capability file (`src-tauri/capabilities/main.json`) grants window
`main` only `core:event:allow-listen` and `core:event:allow-unlisten` — no
other core or plugin permission. The 24 app-defined `#[tauri::command]`s are
not listed in any ACL file, and `src-tauri/build.rs` generates no app ACL
manifest either. Tauri only enforces its capability ACL against an
app-defined (non-plugin) command when the app has its own ACL manifest, or
when the request's origin is remote; with neither here, every app-defined
command is invokable by any local page in the window, ACL-unchecked, while a
command reached from a remote origin is rejected outright. No command
performs an explicit `Origin` check of its own; the practical boundary is
that only the bundled `frontendDist` content is ever loaded into the window
as a local origin, plus the CSP above.

## Control-channel validation

The shell↔sidecar protocol validates strictly and rejects anything outside an
allow-list rather than trying to sanitize free text: `datalink-request` params
must match an exact key set for the given op (`hasExactKeys` — no extra key is
tolerated); canned-message ids, ICAO codes and request ids are all
pattern-checked before use. In a datalink HTTP request, the only value that
becomes a URL path segment is a validated integer id; a canned-message id or
an ICAO code, though pattern-checked the same way, only ever travels in the
JSON request body, never the path or a query string, and no trailing slash
can reach a URL either. This is deliberately strict about "precisely how free
text would be smuggled into a downlink," per the code's own framing.

## Current limitations

Stated factually, as current behaviour rather than a promise to fix:

- **Ingest requests have no per-request timeout and follow redirects, replaying
  the token.** The flight-data ingest client (`uplink.ts`) issues a plain
  `fetch` with no `AbortSignal` and no `redirect` option, so fetch's default,
  `follow`, applies: a 302 from the configured server is followed, and
  `x-ingest-token` is resent to the redirect target. This is inconsistent with
  the datalink client, which sets an explicit 8/25-second timeout and
  `redirect: 'manual'` specifically so a redirect can never replay the token
  to another host. Neither the ingest client nor the reachability probe sets a
  timeout of its own either. A server that accepts a connection and never
  answers holds both the ingest request and the probe until undici's built-in
  300-second headers timeout ends them; both then fail and the Backend axis
  shows `ACARS NO COMM`, but until that point it keeps its last value rather
  than reflecting the stall.
- **Installers are unsigned.** `cargo tauri build` produces an MSI and an NSIS
  `.exe` with no code-signing certificate configured.

## Guidance for contributors

- Use sentinel tokens in tests and examples — `SENTINEL-TOKEN` or the sample
  config's `PLACEHOLDER-TOKEN` — never a real-looking one.
- Use a temporary config for any manual run or test: `--config <path>` on the
  sidecar, or the `MSFSLOGGER_CONFIG` environment variable for either
  process. Never point a test at `%APPDATA%\msfslogger\config.json`.
- Never commit `config.json`, or any file containing a real ingest token or
  server URL.
- The repository has no `SECURITY.md` or other stated vulnerability-reporting
  policy at this time.

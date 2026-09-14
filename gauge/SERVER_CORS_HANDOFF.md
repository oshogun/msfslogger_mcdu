# Handoff: allow the MSFS Coherent GT gauge to ingest flight data

## Problem

The MSFSLogger CDU gauge runs inside MSFS 2020 with this browser origin:

```text
coui://html_ui
```

The gauge is configured and running. Live inspection confirmed all of the
following:

- the server URL is `https://192.168.0.30:3000`;
- an ingest token is stored by the gauge;
- live MSFS SimVars are producing valid aircraft frames;
- Windows/MSFS accepts the server's TLS certificate;
- the requests fail because the server does not allow the Coherent origin.

The Coherent console reports:

```text
Origin coui://html_ui is not allowed by Access-Control-Allow-Origin.
Fetch API cannot load https://192.168.0.30:3000/api/ingest/frame.
```

This is a CORS failure. It is not a certificate-path failure and it occurs
before the gauge can read the ingest response.

## Required server change

Add narrowly scoped CORS middleware to the Express ingest router. It must apply
only to `/api/ingest/*` and allow only the MSFS gauge origin. Do not enable a
wildcard origin for the rest of the application.

The browser sends JSON and the custom `x-ingest-token` header, so preflight
responses must allow both headers and `POST`:

```http
Access-Control-Allow-Origin: coui://html_ui
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, X-Ingest-Token
Vary: Origin
```

An `OPTIONS` request from that origin should return `204` without requiring an
ingest token. Actual `POST` requests must continue through the existing ingest
token authentication.

The best insertion point in the server repository is the start of
`createIngestRouter()` in `src/ingest.ts`, before the route handlers and token
check. Equivalent Express code is:

```ts
const MSFS_COHERENT_ORIGIN = 'coui://html_ui';

router.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin !== MSFS_COHERENT_ORIGIN) {
    next();
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', MSFS_COHERENT_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Ingest-Token');

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  next();
});
```

If `Vary` may already be set by other middleware, use Express's `res.vary('Origin')`
instead of overwriting the header.

## Acceptance tests

Add request-level tests covering these cases:

1. `OPTIONS /api/ingest/frame` with `Origin: coui://html_ui` and
   `Access-Control-Request-Headers: content-type,x-ingest-token` returns `204`
   with the four CORS headers above.
2. A valid authenticated `POST /api/ingest/frame` from `coui://html_ui` keeps
   the existing response/status behavior and includes
   `Access-Control-Allow-Origin: coui://html_ui`.
3. An invalid-token `POST` still returns `401` and includes the allow-origin
   header so Coherent can expose the real status to the gauge.
4. A request with an unrelated origin does not receive an allow-origin header.
5. Existing desktop-agent ingest requests without an `Origin` header behave
   exactly as before.

Run the server's existing test and type-check commands after the change:

```bash
npm test
npm run test:types
```

## Deployment verification

After deploying and restarting the server, verify the preflight response from
another machine on the same network:

```bash
curl -k -i -X OPTIONS 'https://192.168.0.30:3000/api/ingest/frame' \
  -H 'Origin: coui://html_ui' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,x-ingest-token'
```

Expected result: HTTP `204`, an empty body, and the required CORS headers. The
`-k` flag is only for this command-line diagnostic; it does not change MSFS
certificate trust.

Once deployed, the gauge does not need an MSFS restart. Stop and start the
uplink from the CDU, then confirm that the status changes to `ACARS UPLINK`.

## Certificate-path clarification

The desktop Tauri client can read a PEM path such as
`C:\Users\...\msfslogger-cert.pem`. The in-sim Coherent gauge cannot read an
arbitrary Windows certificate file, so its saved `certPath` value has no effect.
The certificate must be trusted by Windows/MSFS. The live request reached the
server and produced a CORS error, which confirms TLS trust is already sufficient
for this connection.

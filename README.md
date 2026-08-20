# Patient Trends — a SMART on FHIR patient viewer

An EHR-launched SMART app that turns a patient's Observation history into
something a clinician can read: every recurring measure as a trend, with the
reference range the record actually asserted, out-of-range readings flagged, and
a direction only where the data supports one.

No configuration surface. No sign-in of its own. It is opened from the EMR or it
shows you why it could not be.

```
launch.html      the EHR launch URL — the app's only entry point
index.html       the viewer, and the OAuth redirect target
config.js        deploy-time configuration; the only place anything is set
styles.css       light and dark, each a selected palette
src/
  smart.js       issuer validation, discovery, PKCE, token exchange, refresh, idle
  fhir.js        paged FHIR reads with bounded retry
  observations.js Observation → trend series, statistics, formatting
  chart.js       SVG sparkline + line chart, crosshair tooltip, table view
  app.js         views and orchestration
  log.js         structured logging with credential redaction
test/
  mock-ehr.mjs   mock EMR + FHIR gateway + authorization server
  e2e.mjs        66 checks — launch, refusals, data, charts, a11y, dark mode
  e2e-session.mjs 21 checks — discovery fallback, silent refresh, expiry, idle
  cdp.mjs        headless-Chrome driver, no npm dependencies
```

Static ES modules. No build step, no bundler, no `node_modules`, no CDN. Deploy
the folder.

---

## Try it in thirty seconds

```bash
node test/mock-ehr.mjs 8099
open http://localhost:8099/
```

That page is a stand-in EMR chart with a **Launch** button, which is how the app
is meant to be entered. The seeded record is five years of longitudinal
observations — A1c, LDL, creatinine, eGFR, haemoglobin, sodium, heart rate,
weight, BMI, and a two-component blood pressure panel — deterministic across
runs, so what you see is what the screenshots show.

---

## The concept: trends, stated honestly

A patient viewer that lists the latest value of everything is a table with extra
steps. The clinically interesting question is *which way is this going, and does
that mean anything* — and answering it responsibly is most of the work here.

**Reference ranges come only from the data.** `Observation.referenceRange` is
used when the server sends it. When it doesn't, the series is drawn with no band
and no in-range judgement, the stat tile says "Not supplied", and the footnote
says so in words. The app never falls back to a built-in threshold table:
inventing a cut-off the record did not assert would make the chart look
authoritative about something it does not know. A server-supplied
`interpretation` code (`H`/`L`/`N`) wins over the app's own numeric comparison,
because the lab knows things the range alone does not — assay, and sex- and
age-specific cuts.

**A direction is only claimed when the fit earns it.** Every series gets an
ordinary least-squares fit, and it has to clear four gates before the app will
say "Rising" or "Falling":

| Gate | Why |
|---|---|
| at least 3 readings | two points are a line, not a trend |
| at least 90 days of span | a direction over three weeks is not a direction |
| R² ≥ 0.30 | the fit has to explain the scatter |
| F = R²/(1−R²)·(n−2) ≥ 10 | …and explain it *for the number of points behind it* |

That last one matters more than it looks. With six or seven readings an R² of
0.35 shows up in pure noise often enough to be worthless — a variance floor
alone would have the app announcing trends that are not there. In the seeded
record, haemoglobin is flat noise across seven readings and reports **Unclear**;
LDL falls across six and reports **Falling**. Same R² neighbourhood, different
verdicts, for a reason you can check. When a slope does survive, the tile prints
the R² beside it so the claim is auditable, and a slope smaller than 5% of the
series' own spread reads **Stable** rather than a spuriously precise rate.

**The chart's vertical scale is a judgement, and it is explained.** An A1c of
7–8 against a 4–6 reference range is the awkward case: include the whole band
and every reading is crushed into a strip at the top; exclude it and the band
silently disappears. The scale reaches toward the band by at most half the
data's own spread, so the trend keeps its shape and a distant band is clipped by
the plot edge — which reads correctly as "the range continues past here". The
footnote says that too.

**A flag marks an exception.** Out-of-range readings get a triangle pointing the
way they went — shape carrying direction, so the flag never depends on colour
alone. But when *every* reading in the window is out of range, per-point flags
mark nothing, so they are dropped and the footnote states it instead. Thirty red
triangles in a row is decoration, not information.

**Comparison uses one axis.** Two y-scales on one plot invent a correlation that
is not in the data, so the compare view indexes each series to its own first
reading in the window and plots percent change on a single shared axis, with the
baseline value named in the legend. It is capped at three series, which is not
arbitrary: those three categorical hues clear the CVD and normal-vision
separation floors on the all-pairs list in both light and dark. A fourth would
not.

Every chart has a table view twin, so no value is only reachable by hovering.

---

## Deploying

**[DEPLOY.md](DEPLOY.md) is the step-by-step guide** — repo creation, Pages
setup, app registration, verification, and a troubleshooting table. What follows
is the summary.

### GitHub Pages

Push the folder as a repo and set Pages to the *GitHub Actions* source.
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) parses every
module, prints the client id / scopes / trusted issuers into the build log, runs
the 66-check end-to-end launch against the bundled mock in headless Chrome, and
only then publishes the root — a broken launch flow never reaches the live URL.

Two URLs get registered with the authorization server:

| Purpose | Value |
|---|---|
| **Launch URL** | `https://<owner>.github.io/<repo>/launch.html` |
| **Redirect URI** | `https://<owner>.github.io/<repo>/index.html` |

The app derives its own redirect URI from where it is deployed and normalises it
to `…/index.html`, so the registered string and the string sent in the authorize
request cannot drift apart over a trailing slash.

### Cloudflare Pages

Framework preset **None**, empty build command, output directory `/`. Or:

```bash
npx wrangler pages deploy . --project-name patient-trends
```

[`_headers`](_headers) sets `no-store` plus `X-Frame-Options: DENY`.
[`_redirects`](_redirects) is deliberately empty — an SPA catch-all would
swallow both `/launch.html` and the `?code=` redirect.

### What to edit in config.js

Only these:

- `clientId` — the public client id the authorization server issued
- `scopes` — what the app asks for at launch
- `trustedIssuers` — the FHIR base URLs this deployment will launch from
- `pinnedEndpoints` — fallback OAuth endpoints per issuer, if discovery is broken
- `session` — refresh lead, idle timeout, idle grace

The loopback entries in `trustedIssuers` and `pinnedEndpoints` are what make the
bundled mock and local development work, and they are **inert once deployed**:
`validateIssuer()` drops every loopback issuer as soon as the app is served from
a non-loopback https origin. Nobody has to remember to strip them before a
deploy.

---

## How it behaves like a production app

**`iss` is validated before anything else happens.** An EHR launch hands the app
an issuer in a URL, and honouring an arbitrary one is the classic SMART attack: a
crafted launch URL points the app at a hostile FHIR server, the app asks that
server's authorization endpoint for a token, and the attacker harvests the code
and the app's behaviour. So `iss` is matched against a pinned list, plaintext
issuers are refused outside loopback, and prefix matching has to break on a `/`
so `https://good.example/fhir/r4.attacker.net` cannot pass as a prefix of
`https://good.example/fhir/r4`. All three refusals are covered by tests.

**PKCE S256, state, and nonce, with the checks actually performed.** The app is
a public client with no secret. `state` is compared strictly and the response
discarded on mismatch; the `id_token` nonce is verified when one comes back; the
authorization code is single-use and stripped from the address bar with
`history.replaceState` so a reload cannot replay it. If the authorization server
advertises `code_challenge_methods_supported` without `S256`, the app declines
to launch rather than silently downgrading.

**Discovery follows the spec, and says when it can't.** It resolves
`{iss}/.well-known/smart-configuration`, then the CapabilityStatement's
`oauth-uris` extension. Only if both fail does it use `pinnedEndpoints`, and then
it logs a warning naming the issuer and marks the route as `pinned-fallback` in
the provenance line at the foot of the page. That branch exists because the
Polaris gateway does not currently advertise either one from its R4 base —
`SmartConfigurationController` registers smart-configuration at the servlet root
and under `/fhir`, neither of which is relative to `/fhir/r4`, and the R4 servlet
has no SMART conformance provider, so `/fhir/r4/metadata` carries no
`oauth-uris`. Delete the pinned entry once that is fixed and the app keeps
working unchanged. `MOCK_HIDE_DISCOVERY=1` reproduces the gap locally.

**The session is managed, not assumed.** The access token is refreshed silently
60 seconds before expiry; a rotating server's new refresh token is picked up. An
idle clinician gets a countdown dialog at 15 minutes with 30 seconds to keep
working. When the session cannot be renewed — no refresh token, or the server
refused — the app clears storage and shows a "Session ended" screen naming the
reason, rather than degrading into blank panels. A 401 from the FHIR server ends
the session through the same path.

Tokens live in `sessionStorage`: gone when the tab closes, never shared with
another tab, and persisted only across the redirect round-trip that has to
survive. A browser-only public client has no better option — there is no
confidential backend to hold it. The logger redacts anything token-shaped, so a
console screenshot from a demo cannot leak a bearer credential.

**Reads are bounded.** Retries are exponential with jitter on 429/502/503/504
only, capped at three attempts; `Retry-After` is honoured. `Bundle.link[next]` is
followed with a page cap, and hitting the cap is logged and surfaced in the
provenance line rather than silently truncating the chart. Cross-origin failures
are reported as cross-origin failures, since that is what they almost always
are. Condition reads are allowed to fail without taking the viewer down; the
Patient read is not, because without it there is nothing to show.

**Every error is a screen with a stable code.** `LAUNCH_UNTRUSTED_ISS`,
`LAUNCH_MISSING_CONTEXT`, `DISCOVERY_FAILED`, `STATE_MISMATCH`,
`TOKEN_EXCHANGE_FAILED`, `NO_PATIENT_CONTEXT`, `FHIR_FORBIDDEN`, `IDLE_TIMEOUT`,
`TOKEN_EXPIRED` — quotable in a support conversation, with prose underneath that
says what to do.

---

## Tests

Two harnesses, both dependency-free — they drive headless Chrome over the
DevTools Protocol using Node 22's built-in `WebSocket`.

```bash
node test/mock-ehr.mjs 8099 &
node test/e2e.mjs                 # 66 checks
node test/e2e-session.mjs         # 21 checks; starts and stops its own mocks

CHROME=/path/to/chrome node test/e2e.mjs    # if Chrome is not auto-detected
```

`e2e.mjs` covers the refusals (direct visit, untrusted issuer, prefix confusion,
missing context, unknown context), the launch, the patient header, component
splitting of blood pressure, paging past one page, the reference-band and
no-reference-range paths, the conservative trend statement, the crosshair
tooltip and its keyboard equivalent, the table view, the three-series compare
cap, small multiples, the time-range filter, dark mode as its own palette, and
sign-out. It also asserts chart specifics that are easy to regress — solid
gridlines, one end-label rather than a label per point, the 2px surface ring on
markers, and that the x-axis band fits inside the rendered box.

`e2e-session.mjs` covers what needs the mock configured differently per case:
the pinned-fallback branch with its warning, a silent refresh observed on the
wire before expiry, a clean session end when no refresh token was issued, and
the idle warning with both outcomes.

Screenshots land in `test/screens/`.

Mock flags:

```bash
MOCK_HIDE_DISCOVERY=1   # no smart-configuration, no oauth-uris → pinned fallback
MOCK_NO_REFRESH=1       # issue no refresh token
MOCK_SHORT_TOKEN=70     # short access-token lifetime, to watch silent refresh
```

---

## Notes for the demo

The record is built to reward the trend view: A1c falling ~0.3 %/yr on a strong
fit, LDL responding, creatinine rising while eGFR slips, weight and BMI drifting
down, sodium and haemoglobin flat and correctly reported as having no clear
direction. Blood pressure arrives as one Observation with two components and
becomes two independently trended series.

Two things worth pointing at while presenting: the **Compare** view, because
"we refuse to draw a second y-axis, here is what we do instead" is a credibility
moment; and the **Direction** tile on a noisy series, because an app that says
"no clear trend" is making a claim about its own limits.

This is a demo against synthetic data. Point it at an environment with real
patient data and the charts, the table view, and any screenshot of the screen
contain that data.

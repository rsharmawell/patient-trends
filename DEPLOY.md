# Deploying Patient Trends to GitHub Pages

Step by step, from a folder on your Mac to a live SMART app an EMR can launch.

Every command runs on your machine, in the app folder:

```bash
cd ~/work/UnifiedDevEnvironment/patient-viewer
```

There is no build step. GitHub Actions publishes the folder as-is.

---

## Step 0 — Decide two things first

**The repository name becomes part of the URL, and the URL becomes the redirect
URI you register with the authorization server.** Changing it later means
re-registering the app, so pick it now:

| Repo | Site URL | Launch URL to register | Redirect URI to register |
|---|---|---|---|
| `patient-trends` | `https://<you>.github.io/patient-trends/` | `…/patient-trends/launch.html` | `…/patient-trends/index.html` |

**Public or private?** GitHub Pages on a *private* repo requires GitHub
Enterprise Cloud — WELLSTAR's Enterprise plan should cover it, but confirm
before assuming, because a private repo whose Pages cannot publish is a
confusing failure. Two things to weigh:

- There is no PHI and no secret in this repo. A public SMART client has no
  client secret by design; PKCE is what protects the flow.
- `config.js` does contain internal hostnames — `fhir-gateway.dev.apps.health`,
  `id.sit.wellstar.health`. On a public repo those become public. If that is
  not acceptable, either go private, or strip `trustedIssuers` and
  `pinnedEndpoints` down to the one environment the demo needs.

Check what you are about to publish:

```bash
node --input-type=module -e "
  const { CONFIG } = await import('./config.js');
  console.log(CONFIG.clientId);
  console.log(CONFIG.trustedIssuers.join('\n'));
"
```

---

## Step 1 — Confirm it works locally first

Never debug a deployment and the app at the same time.

```bash
node test/mock-ehr.mjs 8099
```

Open <http://localhost:8099/> and click **Launch**. You should land on the
viewer with Adaeze Okonkwo's trends. In another terminal:

```bash
node test/e2e.mjs            # expect 66/66
```

Stop the mock (`Ctrl-C`) before moving on.

---

## Step 2 — Make it a git repository

```bash
git init
git branch -M main
git add .
git status                   # read this — see the note below
git commit -m "Patient Trends: EHR-launched SMART on FHIR trend viewer"
```

`git status` should list about 21 files. What matters:

- `.github/workflows/pages.yml` **must** be there — it is the deployment.
- `.nojekyll` **must** be there, or GitHub's Jekyll step strips `_headers`
  and `_redirects` (any file starting with `_`).
- `test/screens/` must **not** be there — `.gitignore` handles it.

> **If `patient-viewer` sits inside the `UnifiedDevEnvironment` repo**, you have
> a repo inside a repo, which git will not track properly. Either move the
> folder out first (`mv ~/work/UnifiedDevEnvironment/patient-viewer ~/work/patient-trends`)
> or add it to `UnifiedDevEnvironment/.gitignore`. Do not commit it as a
> submodule unless you mean to.

---

## Step 3 — Create the GitHub repository

### With the `gh` CLI (fastest)

```bash
gh auth status || gh auth login          # needs the "workflow" scope
gh repo create patient-trends --private --source=. --remote=origin --push
```

`gh repo create --source=. --push` creates the remote, wires `origin`, and
pushes `main` in one go. Use `--public` instead of `--private` if you decided
that in Step 0.

If `gh auth login` was done previously without the `workflow` scope, the push
will be rejected for containing a workflow file. Fix it once:

```bash
gh auth refresh -h github.com -s workflow
```

### Without the CLI

1. Go to <https://github.com/new>.
2. **Repository name**: `patient-trends`. Pick Private or Public.
3. Leave *Add a README*, *.gitignore* and *license* **unchecked** — you already
   have those, and an initial commit on the remote means a merge conflict on
   your first push.
4. **Create repository**, then:

```bash
git remote add origin https://github.com/<you>/patient-trends.git
git push -u origin main
```

If you push over HTTPS with a fine-grained personal access token, the token
needs **Contents: read and write** *and* **Workflows: read and write**. Without
the workflow permission the push fails with
`refusing to allow a Personal Access Token to create or update workflow`.

---

## Step 4 — Turn on Pages, with Actions as the source

This is the step people miss. Pushing the workflow is not enough; the
repository has to be told that Actions publishes the site.

1. Repository → **Settings** → **Pages** (left sidebar, under "Code and automation").
2. **Build and deployment** → **Source** → choose **GitHub Actions**.
   - *Not* "Deploy from a branch". That mode looks for a `gh-pages` branch or
     `/docs`, ignores your workflow, and will serve nothing.
3. There is no Save button on that dropdown — it applies immediately.

With the CLI:

```bash
gh api -X POST repos/:owner/patient-trends/pages -f build_type=workflow
# already enabled? switch it instead:
gh api -X PUT  repos/:owner/patient-trends/pages -f build_type=workflow
```

---

## Step 5 — Run the deployment

The workflow triggers on every push to `main`. Since you pushed before enabling
Pages, kick it off manually:

```bash
gh workflow run pages.yml
gh run watch
```

Or in the browser: **Actions** tab → **Deploy to GitHub Pages** → **Run workflow**.

Two jobs run in order:

- **verify** — parses every module, prints the client id / scopes / trusted
  issuers into the log, then runs the full 66-check end-to-end EHR launch
  against the bundled mock in headless Chrome.
- **deploy** — uploads the folder and publishes it.

`verify` gating `deploy` is deliberate: a broken launch flow never reaches the
live URL.

When it finishes, the URL is on the run summary and in **Settings → Pages**:

```
https://<you>.github.io/patient-trends/
```

First publish can take a couple of minutes to propagate. A 404 immediately
after a green run is usually just propagation — wait 60 seconds and retry
before debugging.

---

## Step 6 — Verify the deployment before touching the EMR

Open the site URL. **You should see "Open this app from the EHR"** with the code
`NOT_LAUNCHED`. That is success: the app has no entry point of its own.

Now check it refuses a hostile launch. In the browser:

```
https://<you>.github.io/patient-trends/launch.html?iss=https://evil.example.com/fhir/r4&launch=x
```

Expect **"Launch refused"** / `LAUNCH_UNTRUSTED_ISS`.

And confirm the redirect URI the app will actually send. Open the site, then in
the browser console:

```js
const { redirectUri } = await import('./src/smart.js');
redirectUri();
// → "https://<you>.github.io/patient-trends/index.html"
```

**Copy that exact string.** It is what you register in Step 7 — not something
you retype.

---

## Step 7 — Register the app with the authorization server

Give whoever administers WELL Identity (or the Keycloak realm) these:

| Field | Value |
|---|---|
| Application type | **Public client / SPA** — no client secret |
| Grant type | `authorization_code` |
| PKCE | **Required**, `S256` |
| Launch URL (EHR launch) | `https://<you>.github.io/patient-trends/launch.html` |
| Redirect URI | `https://<you>.github.io/patient-trends/index.html` |
| Scopes | `launch openid fhirUser online_access patient/Patient.read patient/Observation.read patient/Condition.read` |
| Refresh tokens | Yes, if you want the session to renew silently |

Then put the issued client id into `config.js` and add the environment's FHIR
base URL to `trustedIssuers`:

```js
clientId: 'the-id-they-gave-you',

trustedIssuers: [
  'https://fhir-gateway.dev.apps.health/fhir/r4',
  // …
],
```

```bash
git commit -am "Register client id and trusted issuer for dev"
git push
```

The push redeploys automatically. Watch the `verify` job's "Report what this
deployment trusts" step to confirm the values landed.

---

## Step 8 — The two things that will actually break, and why

Everything above is mechanical. These two are not, and both live on the server
side rather than in this repo.

### CORS on the FHIR server

The app is a browser page on `github.io` calling a FHIR server on another
origin. That server must answer the preflight with
`Access-Control-Allow-Origin` for `https://<you>.github.io` (or `*`), and allow
the `Authorization` header.

The Polaris gateway's HAPI servlets do register a CORS interceptor with
`allowedOriginPatterns = ["*"]`, so FHIR reads should be fine. The
smart-configuration document is a plain Spring `@RestController` with no CORS
on it, which is exactly why `config.js` carries `pinnedEndpoints` — the app
falls back and logs a warning rather than dying. If reads fail, the console will
say `FHIR_UNREACHABLE` with a cross-origin note; that is a server fix, not an
app fix.

### CORS on the token endpoint

A public client exchanges the authorization code from the browser, so the token
endpoint must also allow cross-origin POSTs from your Pages origin. If it does
not, the launch dies at `TOKEN_UNREACHABLE`. Whoever registers the client needs
to add the origin to the authorization server's allowed web origins — on
Keycloak that is the client's **Web origins** field.

### Related: mixed content

An `https://` page cannot call `http://localhost:8092`. Once deployed, the app
can only reach TLS-served FHIR endpoints. This is also why the loopback entries
in `trustedIssuers` go inert on a deployed origin — `validateIssuer()` drops
them rather than letting a crafted launch point the app at something on the
clinician's own machine.

---

## Step 9 — Updating and rolling back

Update: commit, push to `main`, done. The workflow re-verifies and republishes.

Roll back to a previous deployment without reverting code: **Actions** → pick
the good run → **Re-run all jobs**. Or revert the commit:

```bash
git revert <bad-sha>
git push
```

Take the site down: **Settings → Pages → Source → None**, or delete the
`github-pages` environment.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Push rejected: `refusing to allow a Personal Access Token to create or update workflow` | Token or `gh` auth lacks the workflow scope | `gh auth refresh -h github.com -s workflow`, or add **Workflows: read and write** to the PAT |
| Actions tab is empty after pushing | Workflow file not committed, or not at `.github/workflows/` | `git ls-files .github` should list `pages.yml` |
| Run fails: `Unable to resolve action` | An action's major tag moved | Settings → Pages → GitHub Actions → open the **Static HTML** starter workflow and copy its versions into `pages.yml` |
| Run fails at `Locate a browser` | Runner image has no Chrome | Delete the end-to-end step, or add a setup-chrome action |
| Run fails: `Get Pages site failed` / `Resource not accessible` | Pages source is still "Deploy from a branch" | Step 4 |
| Green run but 404 on the site | Propagation, or Pages not enabled with the Actions source | Wait a minute; then re-check Step 4 |
| Page loads but is blank, console shows a MIME type error on `src/app.js` | Jekyll processed the site and mangled it | Confirm `.nojekyll` is committed at the repo root |
| Styles load but `_headers` is missing | Same cause — files starting with `_` were stripped | `.nojekyll` |
| `NOT_LAUNCHED` when you expected the viewer | You opened `index.html` directly | That is correct behaviour; enter through `launch.html?iss=…&launch=…` |
| `LAUNCH_UNTRUSTED_ISS` on a real launch | The EMR's `iss` is not in `trustedIssuers` | Add the exact FHIR base URL, commit, push |
| `DISCOVERY_FAILED` | Server advertises no SMART endpoints and no fallback is pinned for that issuer | Add the issuer to `pinnedEndpoints` |
| `redirect_uri` mismatch from the authorization server | Registered value differs from what the app sends | Re-read it with the console snippet in Step 6 and register that byte-for-byte |
| `TOKEN_UNREACHABLE` | Token endpoint rejects cross-origin POST | Add your Pages origin to the client's allowed web origins |
| `NO_PATIENT_CONTEXT` | Launch context not redeemed, or `launch/patient` not granted | Check the EMR passed `launch=` and the scope was approved |
| Session drops after an hour with no warning | No refresh token issued | Enable refresh tokens on the client, or accept re-launch (the app says so in the console at launch) |

---

## Cloudflare Pages instead

Same repo, if you would rather not use GitHub Pages:

```bash
npx wrangler pages deploy . --project-name patient-trends
```

Or connect the repo in the Cloudflare dashboard with framework preset **None**,
an empty build command, and output directory `/`. `_headers` then takes effect
(GitHub Pages ignores it) and gives you `no-store` plus `X-Frame-Options: DENY`.
Leave `_redirects` empty — an SPA catch-all would swallow both `launch.html` and
the `?code=` redirect.

The registered URLs change to the `*.pages.dev` hostname, so re-register if you
switch.

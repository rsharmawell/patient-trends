/*
 * Deploy-time configuration for the Polaris Patient Trends viewer.
 *
 * This is the ONLY place the app is configured. Nothing here is editable from
 * the UI, and nothing here is read from the query string — a SMART app in
 * production is registered once with the authorization server, and its client
 * id, redirect URI and scopes are fixed properties of that registration.
 *
 * Edit this file at deploy time (or generate it in CI) and nothing else.
 */

export const CONFIG = {
  /* -------------------------------------------------------------- *
   * App registration
   * -------------------------------------------------------------- */

  /** Public client id issued by the authorization server. */
  clientId: 'QDukKIraoKAefrNE9KXgk684LDWlEhm4',

  /**
   * Scopes requested at launch.
   *
   * `launch` is required for an EHR launch — it is what redeems the opaque
   * `launch` parameter into patient context. `online_access` is requested
   * instead of `offline_access`: this is a clinician-facing viewer that should
   * live and die with the EHR session, and the gateway's
   * `scopes_supported` omits `offline_access` anyway. If the authorization
   * server declines to issue a refresh token the app degrades to a re-launch
   * prompt rather than failing.
   */
  scopes: [
    'launch',
    'openid',
    'fhirUser',
    'offline_access',
    'patient/Patient.read',
    'patient/Observation.read',
    'patient/Condition.read',
  ],

  /* -------------------------------------------------------------- *
   * Trusted issuers
   *
   * An EHR launch hands the app an `iss` in the URL. Honouring an arbitrary
   * `iss` is the classic SMART attack: a crafted launch URL points the app at
   * a hostile FHIR server, the app dutifully asks that server's authorization
   * endpoint for a token, and the attacker harvests the resulting code and
   * client behaviour. A production app pins the issuers it will launch from.
   *
   * Entries are matched as exact origin, or origin + path prefix. `*` is not
   * supported on purpose.
   * -------------------------------------------------------------- */

  trustedIssuers: [
    'https://fhir-gateway.dev.apps.health/fhir/r4',
    'https://fhir-gateway.staging.apps.health/fhir/r4',
    'http://localhost:8099/fhir/r4',
    'http://localhost:8092/fhir/r4',
    'http://127.0.0.1:8099/fhir/r4',
    'https://w4511nbn-80.use.devtunnels.ms/fhir/r4'
  ],

  /* -------------------------------------------------------------- *
   * Authorization-server discovery
   *
   * The app follows the SMART App Launch spec: it resolves
   * `{iss}/.well-known/smart-configuration`, then falls back to the
   * CapabilityStatement's `oauth-uris` extension.
   *
   * `pinnedEndpoints` is a third fallback for environments where neither is
   * reachable — which is the case against the Polaris gateway today, because
   * smart-configuration is registered at the servlet root rather than relative
   * to the R4 FHIR base, and the R4 server has no SMART conformance provider.
   * When the app uses it, it logs a warning naming the issuer. Delete the
   * matching entry once discovery works and the app keeps running unchanged.
   * -------------------------------------------------------------- */

  pinnedEndpoints: {
    'https://fhir-gateway.dev.apps.health/fhir/r4': {
      authorizationEndpoint: 'https://id.sit.wellstar.health/api/oa/oauth2/auth',
      tokenEndpoint: 'https://id.sit.wellstar.health/api/oa/oauth2/token',
    },
    'http://localhost:8092/fhir/r4': {
      authorizationEndpoint:
        'https://localhost:2443/auth/realms/oscar/protocol/openid-connect/auth',
      tokenEndpoint:
        'https://localhost:2443/auth/realms/oscar/protocol/openid-connect/token',
    },
    // The bundled mock in test/. Present so the fallback branch can be
    // exercised locally with MOCK_HIDE_DISCOVERY=1; harmless otherwise,
    // because the mock advertises discovery properly by default and the
    // fallback is only consulted when discovery fails.
    'http://localhost:8099/fhir/r4': {
      authorizationEndpoint: 'http://localhost:8099/oauth/authorize',
      tokenEndpoint: 'http://localhost:8099/oauth/token',
    },
  },

  /* -------------------------------------------------------------- *
   * Session policy
   * -------------------------------------------------------------- */

  session: {
    /** Refresh this many seconds before the access token expires. */
    refreshLeadSeconds: 60,
    /** Idle time before the warning appears. */
    idleTimeoutSeconds: 15 * 60,
    /** How long the warning stays up before the session is cleared. */
    idleGraceSeconds: 30,
  },

  /* -------------------------------------------------------------- *
   * Data
   * -------------------------------------------------------------- */

  data: {
    /** Observation categories to pull. */
    categories: ['vital-signs', 'laboratory'],
    /** Page size requested from the server. */
    pageSize: 200,
    /** Hard cap on pages followed, so a runaway `next` chain cannot hang the UI. */
    maxPages: 20,
    /** A series needs at least this many points to be treated as a trend. */
    minPointsForTrend: 3,
  },

  /** Set true to print every request and state transition to the console. */
  debug: true,
};

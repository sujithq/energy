import { createHash, randomBytes } from "node:crypto";

import { CookieJar } from "tough-cookie";

const MSAL_CONFIG_URL = "https://mijn.fluvius.be/api/global/msal/config";
const FLUVIUS_ORIGIN = "https://mijn.fluvius.be";
const DEFAULT_AUTHORITY = "https://login.fluvius.be/klanten.onmicrosoft.com/B2C_1A_customer_signup_signin";
const DEFAULT_REDIRECT_URI = `${FLUVIUS_ORIGIN}/`;
const DEFAULT_SCOPE = "https://klanten.onmicrosoft.com/MijnFluvius/user_impersonation";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 8;
const MAX_HISTORY_DAYS = 7;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BRUSSELS_OFFSET = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Brussels",
  timeZoneName: "longOffset"
});

export async function authenticateFluvius(credentials, options = {}) {
  const email = credentials?.email?.trim();
  const password = credentials?.password;
  if (!email) throw new Error("FLUVIUS_EMAIL is required.");
  if (!password) throw new Error("FLUVIUS_PASSWORD is required.");

  const session = new CookieSession(options);
  try {
    const metadata = await fetchMsalMetadata(session);
    const authority = String(metadata.authority ?? metadata.auth?.authority ?? DEFAULT_AUTHORITY).replace(/\/$/, "");
    const clientId = metadata.clientId ?? metadata.auth?.clientId;
    const redirectUri = metadata.redirectUri ?? metadata.auth?.redirectUri ?? DEFAULT_REDIRECT_URI;
    if (!clientId) throw authenticationError("LOGIN_REJECTED", "Fluvius authentication metadata is incomplete.");

    const scopes = normalizeScopes(metadata);
    const verifier = randomBytes(64).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const authorizeUrl = new URL(`${authority}/oauth2/v2.0/authorize`);
    authorizeUrl.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      response_mode: "query",
      scope: scopes,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      nonce,
      prompt: "login",
      client_info: "1",
      login_hint: email
    }).toString();

    const authorizationPage = await session.follow(authorizeUrl, {
      headers: browserHeaders("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
    });
    if (!authorizationPage.response.ok) {
      throw authenticationError("LOGIN_TIMEOUT", "Fluvius did not open the sign-in page.");
    }
    const html = await authorizationPage.response.text();
    const settings = extractJsonAssignment(html, "SETTINGS");
    const selfAssertedFields = extractJsonAssignment(html, "SA_FIELDS");
    const { loginField, passwordField } = resolveCredentialFields(selfAssertedFields);
    const csrfToken = settings.csrf;
    const transactionId = settings.transId;
    const policy = settings.hosts?.policy;
    const tenantPath = settings.hosts?.tenant;
    if (![csrfToken, transactionId, policy, tenantPath].every(Boolean)) {
      throw authenticationError("LOGIN_REJECTED", "Fluvius sign-in metadata is incomplete.");
    }

    const tenantBase = resolveTenantBase(authorizationPage.url, tenantPath);
    await submitCredentials(session, {
      tenantBase,
      loginField,
      passwordField,
      email,
      password,
      csrfToken,
      transactionId,
      policy,
      referer: authorizationPage.url
    });

    const code = await captureAuthorizationCode(session, {
      tenantBase,
      api: settings.api,
      csrfToken,
      transactionId,
      policy,
      state,
      referer: authorizationPage.url
    });
    return await exchangeAuthorizationCode(session, {
      authority,
      clientId,
      redirectUri,
      scopes,
      code,
      verifier
    });
  } catch (error) {
    if (isPublicAuthenticationError(error)) throw error;
    throw authenticationError("LOGIN_TIMEOUT", "Fluvius authentication could not be completed.");
  }
}

export async function fetchFluviusMeasurements(request, options = {}) {
  const accessToken = request?.accessToken?.trim();
  const meterId = request?.meterId?.trim();
  const meterSerial = request?.meterSerial?.trim();
  const fromDate = request?.fromDate;
  const throughDate = request?.throughDate;
  if (!accessToken) throw authenticationError("LOGIN_REJECTED", "Fluvius did not issue an access token.");
  if (!/^\d{18}$/.test(meterId ?? "")) throw new Error("FLUVIUS_DETAIL_URL must point to an 18-digit meter detail page.");
  if (!meterSerial) throw new Error("FLUVIUS_METER_SERIAL is required.");
  assertIsoDate(fromDate, "FLUVIUS_FROM_DATE");
  assertIsoDate(throughDate, "FLUVIUS_THROUGH_DATE");
  if (fromDate > throughDate) throw new Error("FLUVIUS_FROM_DATE must not be after FLUVIUS_THROUGH_DATE.");

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const records = new Map();

  for (const range of historyRanges(fromDate, throughDate)) {
    options.signal?.throwIfAborted();
    const url = new URL(`/verbruik/api/meter-measurement-history/${meterId}`, FLUVIUS_ORIGIN);
    url.search = new URLSearchParams({
      historyFrom: brusselsBoundary(range.from, false),
      historyUntil: brusselsBoundary(range.through, true),
      granularity: "3",
      asServiceProvider: "false",
      meterSerialNumber: meterSerial
    }).toString();

    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": USER_AGENT
        },
        signal: requestSignal(timeoutMs, options.signal)
      });
    } catch {
      throw new Error("Fluvius API request could not be completed.");
    }

    if (response.status === 401 || response.status === 403) {
      throw authenticationError("LOGIN_REJECTED", "Fluvius rejected the authenticated API session.");
    }
    if (!response.ok) throw new Error(`Fluvius API request failed with HTTP ${response.status}.`);

    let chunk;
    try {
      chunk = await response.json();
    } catch {
      throw new Error("Fluvius API returned invalid JSON.");
    }
    if (!Array.isArray(chunk)) throw new Error("Fluvius API returned an unexpected response.");

    for (const record of chunk) {
      const key = `${record?.d ?? ""}\u0000${record?.de ?? ""}`;
      records.set(key, record);
    }
  }

  return [...records.values()].sort((left, right) => {
    const difference = new Date(left?.d).getTime() - new Date(right?.d).getTime();
    return Number.isNaN(difference) ? String(left?.d).localeCompare(String(right?.d)) : difference;
  });
}

class CookieSession {
  constructor(options) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.cookieJar = options.cookieJar ?? new CookieJar();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.signal = options.signal;
  }

  async request(url, init = {}) {
    const requestUrl = String(url);
    const headers = new Headers(init.headers);
    const cookies = await this.cookieJar.getCookieString(requestUrl);
    if (cookies) headers.set("Cookie", cookies);

    let response;
    try {
      response = await this.fetchImpl(requestUrl, {
        ...init,
        headers,
        redirect: "manual",
        signal: requestSignal(this.timeoutMs, this.signal, init.signal)
      });
    } catch {
      throw authenticationError("LOGIN_TIMEOUT", "Fluvius authentication could not be reached.");
    }

    const setCookies = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
    for (const cookie of setCookies) await this.cookieJar.setCookie(cookie, requestUrl);
    return response;
  }

  async follow(url, init = {}) {
    let currentUrl = new URL(url);
    let currentInit = { ...init };

    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const response = await this.request(currentUrl, currentInit);
      if (!REDIRECT_STATUSES.has(response.status)) return { response, url: currentUrl };

      const location = response.headers.get("location");
      if (!location) throw authenticationError("LOGIN_REJECTED", "Fluvius returned an invalid sign-in redirect.");
      const nextUrl = new URL(location, currentUrl);
      const headers = new Headers(currentInit.headers);
      if (nextUrl.origin !== currentUrl.origin) headers.delete("Authorization");
      const method = String(currentInit.method ?? "GET").toUpperCase();
      if (response.status === 303 || ([301, 302].includes(response.status) && method === "POST")) {
        headers.delete("Content-Type");
        currentInit = { ...currentInit, method: "GET", body: undefined, headers };
      } else {
        currentInit = { ...currentInit, headers };
      }
      currentUrl = nextUrl;
    }

    throw authenticationError("LOGIN_REJECTED", "Fluvius returned too many sign-in redirects.");
  }
}

async function fetchMsalMetadata(session) {
  const { response } = await session.follow(MSAL_CONFIG_URL, {
    headers: browserHeaders("application/json")
  });
  if (!response.ok) throw authenticationError("LOGIN_TIMEOUT", "Fluvius authentication metadata was unavailable.");
  try {
    return await response.json();
  } catch {
    throw authenticationError("LOGIN_REJECTED", "Fluvius authentication metadata is invalid.");
  }
}

async function submitCredentials(session, request) {
  const url = new URL(`${request.tenantBase}/SelfAsserted`);
  url.search = new URLSearchParams({ tx: request.transactionId, p: request.policy }).toString();
  const body = new URLSearchParams({
    request_type: "RESPONSE",
    [request.loginField]: request.email,
    [request.passwordField]: request.password
  });
  const response = await session.request(url, {
    method: "POST",
    headers: {
      ...browserHeaders("application/json, text/javascript, */*; q=0.01"),
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Origin: new URL(request.tenantBase).origin,
      Referer: String(request.referer),
      "X-CSRF-TOKEN": request.csrfToken,
      "X-Requested-With": "XMLHttpRequest"
    },
    body
  });

  let result;
  try {
    result = await response.json();
  } catch {
    throw authenticationError("LOGIN_REJECTED", "Fluvius returned an invalid sign-in response.");
  }
  if (!response.ok || ![200, "200", "success"].includes(result?.status)) {
    throw classifyCredentialFailure(result);
  }
}

async function captureAuthorizationCode(session, request) {
  const api = String(request.api ?? "CombinedSigninAndSignup").replace(/^\/+|\/+$/g, "");
  const url = new URL(`${request.tenantBase}/api/${api}/confirmed`);
  url.search = new URLSearchParams({
    rememberMe: "false",
    csrf_token: request.csrfToken,
    tx: request.transactionId,
    p: request.policy
  }).toString();
  let nextUrl = url;

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await session.request(nextUrl, {
      headers: { ...browserHeaders("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"), Referer: String(request.referer) }
    });
    if (!REDIRECT_STATUSES.has(response.status)) {
      throw authenticationError("LOGIN_REJECTED", "Fluvius did not complete the sign-in redirect.");
    }
    const location = response.headers.get("location");
    if (!location) throw authenticationError("LOGIN_REJECTED", "Fluvius returned an invalid sign-in redirect.");
    const redirectUrl = new URL(location, nextUrl);
    if (redirectUrl.searchParams.has("error")) {
      throw authenticationError("LOGIN_REJECTED", "Fluvius rejected the sign-in request.");
    }
    const code = redirectUrl.searchParams.get("code");
    if (code) {
      if (redirectUrl.searchParams.get("state") !== request.state) {
        throw authenticationError("LOGIN_REJECTED", "Fluvius returned an invalid sign-in state.");
      }
      return code;
    }
    nextUrl = redirectUrl;
  }

  throw authenticationError("LOGIN_REJECTED", "Fluvius did not return an authorization code.");
}

async function exchangeAuthorizationCode(session, request) {
  const response = await session.request(`${request.authority}/oauth2/v2.0/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: request.clientId,
      scope: request.scopes,
      code: request.code,
      redirect_uri: request.redirectUri,
      grant_type: "authorization_code",
      code_verifier: request.verifier
    })
  });
  if (!response.ok) throw authenticationError("LOGIN_REJECTED", "Fluvius rejected the authorization code.");

  let token;
  try {
    token = await response.json();
  } catch {
    throw authenticationError("LOGIN_REJECTED", "Fluvius returned an invalid token response.");
  }
  if (typeof token?.access_token !== "string" || !token.access_token) {
    throw authenticationError("LOGIN_REJECTED", "Fluvius did not issue an access token.");
  }
  return token.access_token;
}

function resolveCredentialFields(fields) {
  const attributes = fields?.AttributeFields;
  if (!Array.isArray(attributes) || !attributes.length) {
    throw authenticationError("LOGIN_REJECTED", "Fluvius sign-in fields are unavailable.");
  }
  const loginField = attributes.find((field) => !field?.IS_PASSWORD)?.ID;
  const passwordField = attributes.find((field) => field?.IS_PASSWORD)?.ID;
  if (!loginField || !passwordField) {
    throw authenticationError("LOGIN_REJECTED", "Fluvius sign-in fields are incomplete.");
  }
  return { loginField, passwordField };
}

function resolveTenantBase(authorizationUrl, tenantPath) {
  if (/^https?:\/\//i.test(tenantPath)) return new URL(tenantPath).toString().replace(/\/$/, "");
  const root = `${authorizationUrl.origin}/`;
  return new URL(String(tenantPath).replace(/^\/+/, ""), root).toString().replace(/\/$/, "");
}

function extractJsonAssignment(html, name) {
  const assignment = new RegExp(`\\b(?:var|let|const)\\s+${name}\\s*=`).exec(html);
  const start = assignment ? html.indexOf("{", assignment.index + assignment[0].length) : -1;
  if (start < 0) throw authenticationError("LOGIN_REJECTED", "Fluvius sign-in metadata is unavailable.");

  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, index + 1));
      } catch {
        throw authenticationError("LOGIN_REJECTED", "Fluvius sign-in metadata is invalid.");
      }
    }
  }
  throw authenticationError("LOGIN_REJECTED", "Fluvius sign-in metadata is incomplete.");
}

function normalizeScopes(metadata) {
  const scopes = [];
  for (const candidate of [
    metadata.scopes,
    metadata.defaultScopes,
    metadata.apiScopes,
    metadata.authRequest?.scopes,
    metadata.protectedResourceMap
  ]) collectScopes(candidate, scopes);
  for (const required of ["openid", "offline_access", DEFAULT_SCOPE]) {
    if (!scopes.includes(required)) scopes.push(required);
  }
  return scopes.join(" ");
}

function collectScopes(value, scopes) {
  if (typeof value === "string") {
    for (const scope of value.split(/\s+/).filter(Boolean)) {
      if (!scopes.includes(scope)) scopes.push(scope);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectScopes(item, scopes);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectScopes(item, scopes);
  }
}

function classifyCredentialFailure(result) {
  const description = JSON.stringify(result ?? {}).toLocaleLowerCase("nl-BE");
  if (/captcha|verification|verificatie|multi-factor|tweestaps|security code|beveiligingscode/.test(description)) {
    return authenticationError("INTERACTIVE_VERIFICATION_REQUIRED", "Fluvius requested an interactive verification step.");
  }
  if (/locked|blocked|vergrendeld|geblokkeerd|too many|te veel/.test(description)) {
    return authenticationError("ACCOUNT_LOCKED", "Fluvius temporarily blocked this sign-in.");
  }
  if (/password|wachtwoord|username|gebruikersnaam|email|e-mail|credential/.test(description)) {
    return authenticationError("INVALID_CREDENTIALS", "Fluvius did not accept the supplied email or password.");
  }
  return authenticationError("LOGIN_REJECTED", "Fluvius rejected the sign-in request.");
}

function historyRanges(fromDate, throughDate) {
  const ranges = [];
  let from = fromDate;
  while (from <= throughDate) {
    const maximumThrough = addDays(from, MAX_HISTORY_DAYS - 1);
    const through = maximumThrough < throughDate ? maximumThrough : throughDate;
    ranges.push({ from, through });
    from = addDays(through, 1);
  }
  return ranges;
}

function brusselsBoundary(date, endOfDay) {
  const time = endOfDay ? "23:59:59.999" : "00:00:00.000";
  const localAsUtc = Date.parse(`${date}T${time}Z`);
  let instant = localAsUtc;
  let offset = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    offset = brusselsOffsetMinutes(new Date(instant));
    instant = localAsUtc - offset * 60_000;
  }
  offset = brusselsOffsetMinutes(new Date(instant));
  const sign = offset < 0 ? "-" : "+";
  const absolute = Math.abs(offset);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `${date}T${time}${sign}${hours}:${minutes}`;
}

function brusselsOffsetMinutes(instant) {
  const name = BRUSSELS_OFFSET.formatToParts(instant).find((part) => part.type === "timeZoneName")?.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name ?? "");
  if (!match) throw new Error("Europe/Brussels timezone data is unavailable.");
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

function addDays(date, count) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

function assertIsoDate(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) throw new Error(`${name} must use YYYY-MM-DD.`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} must use YYYY-MM-DD.`);
  }
}

function browserHeaders(accept) {
  return {
    Accept: accept,
    "Accept-Language": "nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7",
    "User-Agent": USER_AGENT
  };
}

function requestSignal(timeoutMs, ...signals) {
  const activeSignals = signals.filter(Boolean);
  activeSignals.push(AbortSignal.timeout(timeoutMs));
  return activeSignals.length === 1 ? activeSignals[0] : AbortSignal.any(activeSignals);
}

function authenticationError(code, message) {
  return new Error(`AUTH_REQUIRED: ${code}: ${message}`);
}

function isPublicAuthenticationError(error) {
  return error instanceof Error && /^AUTH_REQUIRED: /.test(error.message);
}
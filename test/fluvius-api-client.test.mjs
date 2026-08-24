import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  authenticateFluvius,
  fetchFluviusMeasurements
} from "../scripts/fluvius-api-client.mjs";

test("HTTP authentication completes the B2C PKCE flow with cookies", async () => {
  const calls = [];
  let expectedState;
  let expectedChallenge;
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });

    if (url.pathname === "/api/global/msal/config") {
      return jsonResponse({
        authority: "https://login.example/tenant/policy",
        clientId: "public-client",
        redirectUri: "https://mijn.fluvius.be/",
        scopes: ["openid"]
      });
    }
    if (url.pathname.endsWith("/oauth2/v2.0/authorize")) {
      expectedState = url.searchParams.get("state");
      expectedChallenge = url.searchParams.get("code_challenge");
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.equal(url.searchParams.get("response_type"), "code");
      return new Response(`
        <script>
          var SETTINGS = {"csrf":"csrf-value","transId":"transaction-value","hosts":{"policy":"policy","tenant":"/tenant/policy"},"api":"CombinedSigninAndSignup"};
          var SA_FIELDS = {"AttributeFields":[{"ID":"signInName"},{"ID":"password","IS_PASSWORD":true}]};
        </script>
      `, { status: 200, headers: { "Content-Type": "text/html" } });
    }
    if (url.pathname.endsWith("/SelfAsserted")) {
      const body = new URLSearchParams(init.body);
      assert.equal(body.get("signInName"), "person@example.invalid");
      assert.equal(body.get("password"), "test-password");
      assert.equal(init.headers.get("X-CSRF-TOKEN"), "csrf-value");
      return new Response(JSON.stringify({ status: 200 }), {
        status: 200,
        headers: [
          ["Content-Type", "application/json"],
          ["Set-Cookie", "b2c-session=opaque; Path=/tenant; Secure; HttpOnly"],
          ["Set-Cookie", "b2c-csrf=opaque; Path=/tenant; Secure"]
        ]
      });
    }
    if (url.pathname.endsWith("/api/CombinedSigninAndSignup/confirmed")) {
      assert.match(init.headers.get("Cookie") ?? "", /b2c-session=opaque/);
      return new Response(null, {
        status: 302,
        headers: { Location: "/tenant/policy/continue" }
      });
    }
    if (url.pathname.endsWith("/tenant/policy/continue")) {
      assert.match(init.headers.get("Cookie") ?? "", /b2c-session=opaque/);
      assert.match(init.headers.get("Cookie") ?? "", /b2c-csrf=opaque/);
      return new Response(null, {
        status: 302,
        headers: { Location: `https://mijn.fluvius.be/?code=authorization-code&state=${expectedState}` }
      });
    }
    if (url.pathname.endsWith("/oauth2/v2.0/token")) {
      const body = new URLSearchParams(init.body);
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(body.get("code"), "authorization-code");
      assert.equal(
        createHash("sha256").update(body.get("code_verifier")).digest("base64url"),
        expectedChallenge
      );
      return jsonResponse({ access_token: "opaque-access-token", expires_in: 3600 });
    }
    throw new Error(`Unexpected request path: ${url.pathname}`);
  };

  const accessToken = await authenticateFluvius({
    email: "person@example.invalid",
    password: "test-password"
  }, { fetchImpl });

  assert.equal(accessToken, "opaque-access-token");
  assert.equal(calls.length, 6);
});

test("measurement requests use weekly chunks and Brussels DST offsets", async () => {
  const urls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    urls.push(url);
    assert.equal(init.headers.Authorization, "Bearer test-access-token");
    return jsonResponse([{
      d: url.searchParams.get("historyFrom"),
      de: url.searchParams.get("historyUntil"),
      v: []
    }]);
  };

  const records = await fetchFluviusMeasurements({
    accessToken: "test-access-token",
    meterId: "000000000000000000",
    meterSerial: "private-meter-serial",
    fromDate: "2026-03-25",
    throughDate: "2026-04-05"
  }, { fetchImpl });

  assert.equal(urls.length, 2);
  assert.equal(records.length, 2);
  assert.equal(urls[0].searchParams.get("historyFrom"), "2026-03-25T00:00:00.000+01:00");
  assert.equal(urls[0].searchParams.get("historyUntil"), "2026-03-31T23:59:59.999+02:00");
  assert.equal(urls[1].searchParams.get("historyFrom"), "2026-04-01T00:00:00.000+02:00");
  assert.equal(urls[1].searchParams.get("historyUntil"), "2026-04-05T23:59:59.999+02:00");
  assert.equal(urls[0].searchParams.get("granularity"), "3");
  assert.equal(urls[0].searchParams.get("asServiceProvider"), "false");
});

test("transport failures do not expose meter configuration", async () => {
  const privateMarker = "private-meter-serial-marker";
  await assert.rejects(
    fetchFluviusMeasurements({
      accessToken: "test-access-token",
      meterId: "000000000000000000",
      meterSerial: privateMarker,
      fromDate: "2026-02-09",
      throughDate: "2026-02-09"
    }, {
      fetchImpl: async () => { throw new Error(privateMarker); }
    }),
    (error) => {
      assert.equal(error.message, "Fluvius API request could not be completed.");
      assert.equal(error.message.includes(privateMarker), false);
      return true;
    }
  );
});

test("measurement ranges use the autumn Brussels offset change", async () => {
  let requestedUrl;
  await fetchFluviusMeasurements({
    accessToken: "test-access-token",
    meterId: "000000000000000000",
    meterSerial: "private-meter-serial",
    fromDate: "2026-10-24",
    throughDate: "2026-10-27"
  }, {
    fetchImpl: async (input) => {
      requestedUrl = new URL(input);
      return jsonResponse([]);
    }
  });

  assert.equal(requestedUrl.searchParams.get("historyFrom"), "2026-10-24T00:00:00.000+02:00");
  assert.equal(requestedUrl.searchParams.get("historyUntil"), "2026-10-27T23:59:59.999+01:00");
});

test("measurement cancellation aborts the active request before another chunk", async () => {
  const abortController = new AbortController();
  let requestCount = 0;
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  const fetchImpl = async (input, init) => {
    requestCount += 1;
    notifyStarted();
    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  };

  const request = fetchFluviusMeasurements({
    accessToken: "test-access-token",
    meterId: "000000000000000000",
    meterSerial: "private-meter-serial",
    fromDate: "2026-02-01",
    throughDate: "2026-02-14"
  }, { fetchImpl, signal: abortController.signal });
  await started;
  abortController.abort();

  await assert.rejects(request, /Fluvius API request could not be completed/);
  assert.equal(requestCount, 1);
});

function jsonResponse(value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers }
  });
}
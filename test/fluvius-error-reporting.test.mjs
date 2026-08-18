import assert from "node:assert/strict";
import test from "node:test";

import { publicSyncErrorMessage } from "../scripts/fluvius-error-reporting.mjs";

test("sync error reporting preserves known path-free diagnostics", () => {
  const messages = [
    "AUTH_REQUIRED: INVALID_CREDENTIALS: Fluvius did not accept the supplied email or password.",
    "AUTH_REQUIRED: LOGIN_REJECTED: Fluvius did not accept the authenticated session.",
    "FLUVIUS_THROUGH_DATE must use YYYY-MM-DD.",
    "Temporary Fluvius workspace could not be created.",
    "The new export would remove 2 previously published day(s)."
  ];

  for (const message of messages) {
    assert.equal(publicSyncErrorMessage(new Error(message)), message);
  }
});

test("sync error reporting hides unexpected paths, URLs, and stacks", () => {
  const privateMarker = "private-output-path-marker";
  const errors = [
    new Error(`ENOENT: open 'C:\\${privateMarker}\\supplement.json'`),
    new Error(`Navigation failed at https://example.test/${privateMarker}`),
    { stack: `Error\n    at C:\\${privateMarker}\\script.mjs:1:1` },
    undefined
  ];

  for (const error of errors) {
    const message = publicSyncErrorMessage(error);
    assert.equal(message, "Fluvius refresh failed; no published data was changed.");
    assert.equal(message.includes(privateMarker), false);
  }
});
import assert from "node:assert/strict";
import test from "node:test";

import {
  validateDetailUrl,
  validateIsoDate
} from "../scripts/fluvius-input-validation.mjs";

test("detail URL validation never repeats malformed input", () => {
  const privateInput = "not-a-url-private-value";
  assert.throws(() => validateDetailUrl(privateInput), (error) => {
    assert.equal(error.message, "FLUVIUS_DETAIL_URL must be an HTTPS mijn.fluvius.be URL.");
    assert.equal(error.message.includes(privateInput), false);
    return true;
  });
});

test("detail URL validation requires the Fluvius HTTPS origin", () => {
  assert.throws(
    () => validateDetailUrl("http://mijn.fluvius.be/verbruik"),
    /must be an HTTPS mijn\.fluvius\.be URL/
  );
  assert.throws(
    () => validateDetailUrl("https://example.test/verbruik"),
    /must be an HTTPS mijn\.fluvius\.be URL/
  );
  assert.equal(
    validateDetailUrl("https://mijn.fluvius.be/verbruik"),
    "https://mijn.fluvius.be/verbruik"
  );
});

test("ISO date validation rejects normalized impossible dates", () => {
  assert.doesNotThrow(() => validateIsoDate("2024-02-29", "DATE"));
  for (const value of ["2026-02-29", "2026-02-30", "2026-04-31", "2026-1-01"]) {
    assert.throws(() => validateIsoDate(value, "DATE"), /DATE must use YYYY-MM-DD/);
  }
});
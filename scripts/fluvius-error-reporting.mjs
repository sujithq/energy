const GENERIC_FAILURE = "Fluvius refresh failed; no published data was changed.";
const SAFE_MESSAGES = [
  /^AUTH_REQUIRED: (?:INVALID_CREDENTIALS|ACCOUNT_LOCKED|INTERACTIVE_VERIFICATION_REQUIRED|LOGIN_REJECTED|LOGIN_TIMEOUT): [\w .'-]+$/,
  /^FLUVIUS_(?:EMAIL|PASSWORD|DETAIL_URL) is required\.$/,
  /^FLUVIUS_(?:FROM_DATE|THROUGH_DATE) must use YYYY-MM-DD\.$/,
  /^FLUVIUS_FROM_DATE must not be after FLUVIUS_THROUGH_DATE\.$/,
  /^FLUVIUS_FROM_DATE is required when the supplement is empty\.$/,
  /^FLUVIUS_DETAIL_URL must (?:be an HTTPS mijn\.fluvius\.be URL|point to an 18-digit meter detail page)\.$/,
  /^Temporary Fluvius workspace could not be created\.$/,
  /^The grid supplement does not match schema version 1\.$/,
  /^The downloaded CSV produced no complete grid days\.$/,
  /^The downloaded CSV does not match the requested range \d{4}-\d{2}-\d{2} through \d{4}-\d{2}-\d{2}: observed (?:no dated rows|\d{4}-\d{2}-\d{2} through \d{4}-\d{2}-\d{2}); \d+ missing and \d+ out-of-range day\(s\)\.$/,
  /^The new export would remove \d+ previously published day\(s\)\.$/,
  /^Privacy validation failed: candidate output contains an 18-digit identifier\.$/,
  /^The downloaded CSV filename does not match the configured Fluvius meter\.$/,
  /^Fluvius export dialog date fields could not be identified\.$/,
  /^Fluvius export dialog no longer offers \/[^\r\n]+\/[a-z]*\.$/,
  /^Fluvius reset the requested (?:start|end) date to (?:an empty value|\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})\.$/
];

export function publicSyncErrorMessage(error) {
  const message = error instanceof Error ? error.message : "";
  return SAFE_MESSAGES.some((pattern) => pattern.test(message)) ? message : GENERIC_FAILURE;
}
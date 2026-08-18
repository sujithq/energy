const DETAIL_URL_ERROR = "FLUVIUS_DETAIL_URL must be an HTTPS mijn.fluvius.be URL.";

export function validateIsoDate(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} must use YYYY-MM-DD.`);

  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} must use YYYY-MM-DD.`);
  }
}

export function validateDetailUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(DETAIL_URL_ERROR);
  }

  if (url.protocol !== "https:" || url.hostname !== "mijn.fluvius.be") {
    throw new Error(DETAIL_URL_ERROR);
  }
  return url.toString();
}
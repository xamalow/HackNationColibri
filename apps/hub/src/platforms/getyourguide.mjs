// GetYourGuide adapter STUB (requirement 5). Builds the real payload; sends nothing in this build.
//
// Real API (GetYourGuide Supplier API, for connected suppliers / reservation systems; access is granted by GYG
// after a supplier account and an integration review):
//   - Availability and closures are PUSHED by the supplier with "notify availability update":
//       POST {base}/1/notify-availability-update/   HTTP Basic auth with the credentials GYG issues
//       body: { data: { productId, availabilities: [ { dateTime, vacancies, cutoffSeconds }, ... ] } }
//     A closed day is an availability with vacancies 0 (a "closure"); reopening sends the capacity again.
//   - GYG PULLS from the supplier's own endpoints (get-availabilities, reserve, book, cancel-booking); those are
//     inbound and belong to src/intake/platforms.mjs, not here.
//   - Listing content (title, description, price display, photos) is edited in the GYG supplier portal; the
//     Supplier API has no content-update endpoint, so publishListing reports "unsupported_by_platform" and the
//     fail-safe alert tells Noor's helper to apply it by hand.
//
// Credentials come from environment variables ONLY (names below), never from files in git.
import { NotImplementedError, UnsupportedByPlatformError, requireEnv } from "./errors.mjs";

export const GYG_ENV = ["GYG_SUPPLIER_API_USER", "GYG_SUPPLIER_API_KEY", "GYG_PRODUCT_ID"];
export const GYG_DEFAULT_BASE = "https://supplier-api.getyourguide.com";

/** Pure: the notify-availability-update body for a set of day changes. Tour start time is local "HH:MM". */
export function buildGygAvailabilityUpdate({ productId, days, startTime = "09:00", utcOffset = "+03:00", cutoffSeconds = 86400 }) {
  return {
    data: {
      productId,
      availabilities: days.map((d) => ({
        dateTime: `${d.date}T${startTime}:00${utcOffset}`,
        vacancies: d.open ? Math.max(0, d.capacity ?? 0) : 0,
        cutoffSeconds,
      })),
    },
  };
}

export function getYourGuideAdapter({ env = process.env } = {}) {
  const config = () => requireEnv("getyourguide", env, GYG_ENV);
  return {
    name: "getyourguide",
    configured() { return GYG_ENV.every((n) => typeof env[n] === "string" && env[n].trim() !== ""); },
    async sendAvailability(item) {
      const c = config();
      // Built so it can be inspected in tests; the HTTP call is deliberately not made in this build.
      buildGygAvailabilityUpdate({ productId: c.GYG_PRODUCT_ID, days: item.days });
      throw new NotImplementedError("getyourguide", "notify-availability-update");
    },
    async sendListing() {
      config();
      throw new UnsupportedByPlatformError("getyourguide", "listing content");
    },
  };
}

// Booking.com adapter STUB (requirement 5). Builds the real payload; sends nothing in this build.
//
// Real API: the Booking.com Connectivity API is PARTNER-ONLY. Only certified connectivity providers (channel
// managers, PMS vendors) in the Connectivity Partner Programme get machine-account credentials; a single farm
// cannot sign up directly. Realistic path for Noor: a channel manager that is already a partner, or manual edits
// in the Booking.com extranet by her helper.
//   - Availability / closures (accommodation inventory): OTA_HotelAvailNotif (OTA 2003B XML) over HTTPS with the
//     machine account (HTTP Basic). A closed day = an AvailStatusMessage with RestrictionStatus Status="Close".
//   - Content: OTA_HotelDescriptiveContentNotif (property content), again partner-only.
//   - Booking.com "Attractions" (tours/activities) has no public supplier API; products are onboarded by
//     Booking.com or via connected ticketing systems. Treat any tour listing there as manual.
//
// Credentials come from environment variables ONLY (names below), never from files in git.
import { NotImplementedError, UnsupportedByPlatformError, requireEnv } from "./errors.mjs";

export const BOOKING_COM_ENV = ["BOOKING_COM_MACHINE_USER", "BOOKING_COM_MACHINE_PASSWORD", "BOOKING_COM_HOTEL_ID", "BOOKING_COM_ROOM_ID"];

const xmlEscape = (s) => String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);

/** Pure: an OTA_HotelAvailNotif body that opens/closes each day. */
export function buildOtaHotelAvailNotif({ hotelId, roomId, days }) {
  const msgs = days.map((d) =>
    `<AvailStatusMessage><StatusApplicationControl Start="${xmlEscape(d.date)}" End="${xmlEscape(d.date)}" InvTypeCode="${xmlEscape(roomId)}"/>` +
    `<RestrictionStatus Status="${d.open ? "Open" : "Close"}"/></AvailStatusMessage>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><OTA_HotelAvailNotifRQ xmlns="http://www.opentravel.org/OTA/2003/05" Version="3.000">` +
    `<AvailStatusMessages HotelCode="${xmlEscape(hotelId)}">${msgs}</AvailStatusMessages></OTA_HotelAvailNotifRQ>`;
}

export function bookingComAdapter({ env = process.env } = {}) {
  const config = () => requireEnv("booking_com", env, BOOKING_COM_ENV);
  return {
    name: "booking_com",
    configured() { return BOOKING_COM_ENV.every((n) => typeof env[n] === "string" && env[n].trim() !== ""); },
    async sendAvailability(item) {
      const c = config();
      buildOtaHotelAvailNotif({ hotelId: c.BOOKING_COM_HOTEL_ID, roomId: c.BOOKING_COM_ROOM_ID, days: item.days });
      throw new NotImplementedError("booking_com", "OTA_HotelAvailNotif");
    },
    async sendListing() {
      config();
      throw new UnsupportedByPlatformError("booking_com", "tour listing content");
    },
  };
}

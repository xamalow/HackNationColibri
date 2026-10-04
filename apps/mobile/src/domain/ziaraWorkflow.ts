export type BookingRequestInput = { visitorName: string; date: string; partySize: number; phone: string };
type BookingRequest = (input: BookingRequestInput) => Promise<{ ok: true } | { ok: false; message: string }>;

export type BookingRequestOutcome =
  | { status: 'proposed' }
  | { status: 'refused'; message: string }
  | { status: 'failed'; message: string };

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** A successful request only creates a proposal for Today; it does not confirm the visit. */
export async function runBookingRequest(input: BookingRequestInput, request: BookingRequest): Promise<BookingRequestOutcome> {
  try {
    const result = await request(input);
    return result.ok ? { status: 'proposed' } : { status: 'refused', message: result.message };
  } catch (error) {
    return { status: 'failed', message: errorMessage(error) };
  }
}

export type ArrivalStatus = 'arrived' | 'no_show';
type MarkArrival<TBooking> = (booking: TBooking, status: ArrivalStatus) => Promise<{ ok: boolean; reason?: string }>;

export type ArrivalOutcome =
  | { status: 'recorded' }
  | { status: 'refused'; message: string }
  | { status: 'failed'; message: string };

/** Converts the arrival write result or exception into an outcome the owner can see. */
export async function runArrivalUpdate<TBooking>(booking: TBooking, status: ArrivalStatus, mark: MarkArrival<TBooking>): Promise<ArrivalOutcome> {
  try {
    const result = await mark(booking, status);
    return result.ok ? { status: 'recorded' } : { status: 'refused', message: result.reason ?? 'arrival_refused' };
  } catch (error) {
    return { status: 'failed', message: errorMessage(error) };
  }
}

export const ZIARA_WRITE_GUARD = 'ziara-write';
export const arrivalBusyKey = (bookingId: string, status: ArrivalStatus): string => `arrival:${bookingId}:${status}`;

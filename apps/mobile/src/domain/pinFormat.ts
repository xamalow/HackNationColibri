/** Sauti PINs are exactly four ASCII digits. Keep this check free of native imports. */
export const isValidPin = (pin: string): boolean => /^\d{4}$/.test(pin);

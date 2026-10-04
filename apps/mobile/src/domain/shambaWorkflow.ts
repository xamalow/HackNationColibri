import { isValidPin } from './pinFormat';

type PinEnrollment = (pin: string) => Promise<{ ok: true; ms: number } | { ok: false; error: string }>;

export type PinEnrollmentOutcome =
  | { status: 'invalid' }
  | { status: 'mismatch' }
  | { status: 'enrolled'; ms: number }
  | { status: 'refused'; message: string }
  | { status: 'failed'; message: string };

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** The outcome used by the Shamba PIN button, separated from React so it can be exercised directly. */
export async function runPinEnrollment(first: string, second: string, enroll: PinEnrollment): Promise<PinEnrollmentOutcome> {
  if (!isValidPin(first) || !isValidPin(second)) return { status: 'invalid' };
  if (first !== second) return { status: 'mismatch' };
  try {
    const result = await enroll(first);
    return result.ok ? { status: 'enrolled', ms: result.ms } : { status: 'refused', message: result.error };
  } catch (error) {
    return { status: 'failed', message: errorMessage(error) };
  }
}

type FarmSave<TForm> = (form: TForm) => Promise<{ ok: true; revision: { revision: number } } | { ok: false; errors: string[] }>;
export type FarmSaveOutcome =
  | { status: 'saved'; revision: number }
  | { status: 'invalid'; errors: string[] }
  | { status: 'failed'; message: string };

/** Maps save validation/storage results into outcomes the screen must show to the owner. */
export async function runFarmSave<TForm>(form: TForm, save: FarmSave<TForm>): Promise<FarmSaveOutcome> {
  try {
    const result = await save(form);
    return result.ok
      ? { status: 'saved', revision: result.revision.revision }
      : { status: 'invalid', errors: [...result.errors] };
  } catch (error) {
    return { status: 'failed', message: errorMessage(error) };
  }
}

type DemoFarmLoad = () => Promise<{ loaded: boolean; errors?: string[] }>;
export type DemoFarmOutcome =
  | { status: 'loaded' | 'already_exists' }
  | { status: 'invalid'; errors: string[] }
  | { status: 'failed'; message: string };

/** Loads the synthetic sheet only when empty and distinguishes a race with a real save. */
export async function runDemoFarmLoad(load: DemoFarmLoad): Promise<DemoFarmOutcome> {
  try {
    const result = await load();
    if (result.errors?.length) return { status: 'invalid', errors: [...result.errors] };
    return result.loaded ? { status: 'loaded' } : { status: 'already_exists' };
  } catch (error) {
    return { status: 'failed', message: errorMessage(error) };
  }
}

/** Toggle one schedule day without mutating the prior React state. */
export function toggleWeekday<T extends string>(days: readonly T[], day: T): T[] {
  return days.includes(day) ? days.filter((current) => current !== day) : [...days, day];
}

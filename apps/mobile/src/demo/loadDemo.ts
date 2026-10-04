import { loadDemoFarm } from '../domain/farm';
import { loadDemoFeedback } from '../import/feedbackImport';

/** SYNTHETIC demo data: the hub's demo farm (only if none is saved yet) + the bundled reviews. */
export async function loadDemoData(): Promise<{ reviews: number; farmLoaded: boolean }> {
  const farm = await loadDemoFarm();
  const reviews = await loadDemoFeedback();
  return { reviews: reviews.imported, farmLoaded: farm.loaded };
}

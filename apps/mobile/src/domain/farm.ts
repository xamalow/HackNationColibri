import { formatTimestamp, makeRevision, validateFarmSheet, type FactRevision, type FarmSheet, type Weekday } from '@sauti/core';
import { appendAudit, coreDb, readClock, sha256, TENANT_ID } from './coreDb';

/** The current farm sheet revision (W1 facts). Null until Noor saves it once in Shamba. */
export async function readFacts(): Promise<FactRevision | null> {
  const db = await coreDb();
  const row = (await db.execute('SELECT sheet_json FROM sauti_facts WHERE tenant_id = ?;', [TENANT_ID])).rows[0];
  return row?.sheet_json ? (JSON.parse(String(row.sheet_json)) as FactRevision) : null;
}

export type FarmForm = {
  price: string;
  capacity: string;
  days: Weekday[];
  start: string;
  end: string;
  directions: string;
  inclusions: string;
};

const toInt = (v: string): number | null => (v.trim() === '' ? null : Number(v.trim()));

/**
 * Code validates every field (core validateFarmSheet); empty fields stay null and are never guessed.
 * Each save is a NEW revision: pending proposals built on the old one are refused at approval
 * (fact_revision_mismatch) and must be prepared again.
 */
export async function saveFarmSheet(form: FarmForm): Promise<{ ok: true; revision: FactRevision } | { ok: false; errors: string[] }> {
  const candidate: Record<string, unknown> = {
    price_per_person_kes: toInt(form.price),
    capacity_per_tour: toInt(form.capacity),
    days: form.days.length ? form.days : null,
    hours: form.start.trim() && form.end.trim() ? { start: form.start.trim(), end: form.end.trim() } : null,
    directions_sw: form.directions.trim() || null,
    inclusions_sw: form.inclusions.trim() ? form.inclusions.split(',').map((s) => s.trim()).filter(Boolean) : null,
  };
  const valid = validateFarmSheet(candidate);
  if (!valid.ok) return valid;
  const previous = await readFacts();
  const clock = await readClock();
  const revision = makeRevision(valid.sheet as FarmSheet, (previous?.revision ?? 0) + 1, 'shamba_screen', clock.effectiveMs, sha256);
  const db = await coreDb();
  await db.transaction(async (tx) => {
    await tx.execute(
      'INSERT INTO sauti_facts (tenant_id, revision, sheet_json) VALUES (?, ?, ?) ON CONFLICT(tenant_id) DO UPDATE SET revision = excluded.revision, sheet_json = excluded.sheet_json;',
      [TENANT_ID, revision.revision, JSON.stringify(revision)],
    );
  });
  await appendAudit({ at: formatTimestamp(clock.effectiveMs), action_id: '-', event: 'farm_sheet_saved', detail: `revision ${revision.revision} ${revision.content_hash}` });
  return { ok: true, revision };
}

export function formFromSheet(sheet: FarmSheet | null): FarmForm {
  return {
    price: sheet?.price_per_person_kes != null ? String(sheet.price_per_person_kes) : '',
    capacity: sheet?.capacity_per_tour != null ? String(sheet.capacity_per_tour) : '',
    days: sheet?.days ?? [],
    start: sheet?.hours?.start ?? '',
    end: sheet?.hours?.end ?? '',
    directions: sheet?.directions_sw ?? '',
    inclusions: (sheet?.inclusions_sw ?? []).join(', '),
  };
}

/**
 * The SYNTHETIC demo farm, identical to the hub's apps/hub/fixtures/farm_sheet.json (Max's demo), so the phone and
 * the hub quote the same price, capacity, days and hours. Loaded only when no farm sheet exists yet.
 */
export const DEMO_FARM_FORM: FarmForm = {
  price: '2000',
  capacity: '10',
  days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
  start: '09:00:00',
  end: '15:00:00',
  directions: 'Kutoka mji wa Machakos, fuata barabara ya Kangundo kilomita nane, pinda kushoto kwenye kanisa la mawe, shamba ni la tatu upande wa kulia.',
  inclusions: 'kutembea shambani, kahawa iliyochomwa, chakula cha mchana',
};

export async function loadDemoFarm(): Promise<{ loaded: boolean; errors?: string[] }> {
  if (await readFacts()) return { loaded: false };
  const out = await saveFarmSheet(DEMO_FARM_FORM);
  return out.ok ? { loaded: true } : { loaded: false, errors: out.errors };
}

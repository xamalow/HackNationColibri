const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
export type DomainDigest = (domain: string, value: unknown) => string;

type EvidenceIdentity = {
  source_id: string;
  content_hash: string;
  span: { start: number; end: number };
};

type MissingInfoAnalysis = {
  themes: {
    theme: string;
    verdict: string;
    comment_count: number;
    evidence: EvidenceIdentity[];
    rejected: { item: EvidenceIdentity; reason: string }[];
  }[];
  rejected_tags: { item: { theme: string; evidence: EvidenceIdentity }; reason: string }[];
  ask_a_person: { reason: Exclude<MissingInfoReason, 'insufficient_feedback'>; detail: string; about: string[] }[];
};

export type MissingInfoReason =
  | 'insufficient_feedback'
  | 'structured_output_failure'
  | 'unsupported_language'
  | 'contradictory_reviews'
  | 'evidence_invalid';

export type MissingInfoQuestion = {
  id: string;
  reason: MissingInfoReason;
  theme: string | null;
};

function reportIdentity(analysis: MissingInfoAnalysis, digestValue: DomainDigest): string {
  const snapshot = {
    themes: analysis.themes.map((theme) => ({
      theme: theme.theme,
      verdict: theme.verdict,
      comment_count: theme.comment_count,
      evidence: theme.evidence.map((item) => ({
        source_id: item.source_id,
        content_hash: item.content_hash,
        start: item.span.start,
        end: item.span.end,
      })).sort((a, b) => compare(`${a.source_id}:${a.start}`, `${b.source_id}:${b.start}`)),
      rejected: theme.rejected.map(({ item, reason }) => ({
        reason,
        source_id: item.source_id,
        content_hash: item.content_hash,
        start: item.span.start,
        end: item.span.end,
      })).sort((a, b) => compare(`${a.source_id}:${a.start}:${a.reason}`, `${b.source_id}:${b.start}:${b.reason}`)),
    })).sort((a, b) => compare(a.theme, b.theme)),
    rejected_tags: analysis.rejected_tags.map(({ item, reason }) => ({
      reason,
      theme: item.theme,
      source_id: item.evidence.source_id,
      content_hash: item.evidence.content_hash,
      start: item.evidence.span.start,
      end: item.evidence.span.end,
    })).sort((a, b) => compare(`${a.source_id}:${a.start}:${a.reason}`, `${b.source_id}:${b.start}:${b.reason}`)),
    asks: analysis.ask_a_person.map(({ reason, detail, about }) => ({ reason, detail, about: [...about].sort() }))
      .sort((a, b) => compare(`${a.reason}:${a.about.join(',')}:${a.detail}`, `${b.reason}:${b.about.join(',')}:${b.detail}`)),
  };
  return digestValue('sauti.mobile.feedback_report.v1', snapshot);
}

/** Return stable, evidence-bound owner questions for everything Core cannot conclude. */
export function buildMissingInfoQuestions(analysis: MissingInfoAnalysis, digestValue: DomainDigest): MissingInfoQuestion[] {
  const currentReport = reportIdentity(analysis, digestValue);
  const candidates: { reason: MissingInfoReason; theme: string | null }[] = [
    ...analysis.themes
      .filter((theme) => theme.verdict === 'insufficient')
      .map((theme) => ({ reason: 'insufficient_feedback' as const, theme: theme.theme })),
    ...analysis.ask_a_person.map((ask) => ({
      reason: ask.reason,
      theme: analysis.themes.some((candidate) => candidate.theme === ask.about[0]) ? ask.about[0]! : null,
    })),
  ];

  const unique = new Map<string, MissingInfoQuestion>();
  for (const candidate of candidates) {
    const id = digestValue('sauti.mobile.ask_person.v1', {
      report: currentReport,
      reason: candidate.reason,
      theme: candidate.theme,
    });
    unique.set(id, { id, ...candidate });
  }
  return [...unique.values()];
}

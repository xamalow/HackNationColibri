export type TaggerLabel = { message_id: string; theme: string; sentiment: 'positive' | 'negative' | 'neutral'; quote: string; start: number; end: number };
export type TaggerOutput = { status: string; labels: TaggerLabel[]; untagged: { message_id: string; reason: string }[] };
export const THEMES: readonly string[];
export function tagFeedback(messages: { id: string; text: string; lang?: string }[]): TaggerOutput;

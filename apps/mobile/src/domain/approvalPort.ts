import type { OutboxItem } from './types';

export type ApprovalAvailability = {
  ready: boolean;
  reason: string | null;
};

export interface FrozenDomainApprovalApi {
  readonly contractRevision: string;
  approveExact(request: unknown): Promise<unknown>;
  listOutbox(): Promise<OutboxItem[]>;
}

let frozenApprovalApi: FrozenDomainApprovalApi | null = null;

export function bindFrozenDomainApprovalApi(api: FrozenDomainApprovalApi): void {
  if (!api.contractRevision.trim()) throw new Error('A frozen Domain contract revision is required.');
  frozenApprovalApi = api;
}

export function getApprovalAvailability(): ApprovalAvailability {
  return frozenApprovalApi
    ? { ready: true, reason: null }
    : { ready: false, reason: 'Waiting for the jointly frozen Domain/Platform approval contract.' };
}

export async function readApprovedOutbox(): Promise<OutboxItem[]> {
  if (!frozenApprovalApi) return [];
  return frozenApprovalApi.listOutbox();
}

export async function approveExactWithDomain(request: unknown): Promise<unknown> {
  if (!frozenApprovalApi) throw new Error(getApprovalAvailability().reason ?? 'Domain approval is unavailable.');
  return frozenApprovalApi.approveExact(request);
}

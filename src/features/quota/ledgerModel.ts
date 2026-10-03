import type { TFunction } from 'i18next';
import type {
  AntigravityQuotaState,
  AuthFileItem,
  ClaudeQuotaState,
  CodexQuotaState,
  DevinQuotaState,
  KimiQuotaState,
  MetaQuotaState,
  XaiQuotaState,
} from '@/types';
import { normalizePlanType, PREMIUM_CODEX_PLAN_TYPES, resolveResetMs } from '@/utils/quota';
import { getQuotaDisplayName } from '@/utils/quota/identity';
import type { QuotaCardState } from './providers';
import type { QuotaProviderType } from './providers/types';

export interface LedgerWindow {
  id: string;
  label?: string;
  labelKey?: string;
  labelParams?: Record<string, string | number>;
  remaining: number | null;
  resetAtMs?: number | null;
  resetLabel?: string;
  periodHours?: number | null;
}

export function clampRemaining(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : null;
}

const remainingFromUsed = (used: number | null | undefined) =>
  typeof used === 'number' ? clampRemaining(100 - used) : null;

/** Only observations from a successful fetch contribute to the ledger. */
export function ledgerWindows(type: QuotaProviderType, quota?: QuotaCardState): LedgerWindow[] {
  if (quota?.status !== 'success') return [];
  switch (type) {
    case 'claude': {
      const windows = (quota as ClaudeQuotaState).windows ?? [];
      const priority = ['seven-day-fable', 'five-hour', 'seven-day'];
      return windows
        .map((window) => ({ ...window, remaining: remainingFromUsed(window.usedPercent) }))
        .sort((a, b) => {
          const rank = (id: string) => {
            const index = priority.indexOf(id);
            return index < 0 ? priority.length : index;
          };
          return rank(a.id) - rank(b.id);
        });
    }
    case 'codex':
      return ((quota as CodexQuotaState).windows ?? [])
        .map((window) => ({ ...window, remaining: remainingFromUsed(window.usedPercent) }))
        .sort((a, b) => Number(b.id === 'weekly') - Number(a.id === 'weekly'));
    case 'antigravity':
      return ((quota as AntigravityQuotaState).groups ?? []).flatMap((group) =>
        group.buckets.map((bucket) => ({
          ...bucket,
          id: `${group.id}:${bucket.id}`,
          remaining: clampRemaining(bucket.remainingFraction * 100),
          resetLabel: bucket.resetTime,
        }))
      );
    case 'devin':
      return ((quota as DevinQuotaState).windows ?? []).map((window) => ({
        ...window,
        labelKey: `devin_quota.${window.id}`,
        remaining: clampRemaining(window.remainingPercent),
      }));
    case 'kimi':
      return ((quota as KimiQuotaState).rows ?? []).map((row) => ({
        ...row,
        remaining: row.limit > 0 ? clampRemaining((1 - row.used / row.limit) * 100) : null,
        resetLabel: row.resetHint,
      }));
    case 'meta':
      return ((quota as MetaQuotaState).data?.windows ?? []).map((window) => ({
        ...window,
        labelKey: `meta_quota.${window.id}`,
        remaining: remainingFromUsed(window.usedPercent),
        resetAtMs: window.resetAt === undefined ? null : window.resetAt * 1000,
        periodHours: window.durationMinutes === undefined ? null : window.durationMinutes / 60,
      }));
    case 'xai': {
      const billing = (quota as XaiQuotaState).billing;
      // Monthly billing rollover and paid-health checks are not weekly capacity.
      if (!billing || billing.periodType !== 'weekly' || billing.mode === 'paid-health') return [];
      return [
        {
          id: 'weekly',
          labelKey: 'xai_quota.weekly_limit',
          remaining: remainingFromUsed(billing.usagePercent),
          resetAtMs: billing.resetAtMs,
          periodHours: billing.periodHours,
        },
      ];
    }
  }
}

/** Select the same window across accounts; never add unrelated limits together. */
export function primaryLedgerWindow(
  type: QuotaProviderType,
  windows: LedgerWindow[]
): LedgerWindow {
  const weekly = windows.find((window) => window.id === 'weekly' || window.id === 'seven-day');
  if (type === 'claude') {
    return (
      windows.find((window) => window.id === 'seven-day-fable') ??
      weekly ?? {
        id: 'seven-day',
        labelKey: 'claude_quota.seven_day',
        remaining: null,
      }
    );
  }
  if (type === 'codex') {
    return (
      weekly ??
      windows.find((window) => window.id === 'monthly') ?? {
        id: 'weekly',
        labelKey: 'codex_quota.secondary_window',
        remaining: null,
      }
    );
  }
  return (
    weekly ??
    windows.find((window) => window.periodHours === 168) ??
    windows[0] ?? {
      id: 'weekly',
      labelKey: 'quota_management.weekly_limit',
      remaining: null,
    }
  );
}

export function aggregateLedgerWindow(windows: Array<LedgerWindow | undefined>, now: number) {
  const segments = windows.map((window) => clampRemaining(window?.remaining));
  const knownCount = segments.filter((value) => value !== null).length;
  const resetTimes = windows.flatMap((window, index) =>
    segments[index] !== null &&
    window !== undefined &&
    typeof window.resetAtMs === 'number' &&
    Number.isFinite(window.resetAtMs) &&
    window.resetAtMs > now
      ? [window.resetAtMs]
      : []
  );
  return {
    segments,
    knownCount,
    // A partial total would falsely imply unloaded accounts are exhausted.
    remaining:
      knownCount === windows.length && knownCount > 0
        ? segments.reduce<number>((total, value) => total + (value ?? 0), 0)
        : null,
    capacity: windows.length * 100,
    nextResetAtMs: resetTimes.length ? Math.min(...resetTimes) : null,
  };
}

function maskAddress(address: string): string {
  const [local, domain] = address.split('@');
  if (!local || !domain) return address;
  // Retain the provider/file prefix, while concealing the entire mailbox name.
  const prefix =
    local.match(/^(?:claude|codex|antigravity|devin|kimi|meta|xai)-(?:[a-f0-9]{8,}-)?/i)?.[0] ?? '';
  const mailbox = local.slice(prefix.length);
  const suffix = domain.slice(domain.lastIndexOf('.'));
  return `${prefix}${mailbox.charAt(0)}•••@${domain.charAt(0)}•••${suffix}`;
}

export function ledgerDisplayName(file: AuthFileItem, showEmails: boolean): string {
  const name = getQuotaDisplayName(file);
  if (showEmails) return name;
  // Strip the file extension first so it cannot be mistaken for an email TLD.
  return name
    .split(/(\.json)/i)
    .map((part) =>
      part.replace(/[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu, maskAddress)
    )
    .join('');
}

export function ledgerPlanLabel(
  type: QuotaProviderType,
  quota: QuotaCardState | undefined,
  t: TFunction
): string | null {
  if (quota?.status !== 'success') return null;
  if (type === 'codex') {
    const raw = (quota as CodexQuotaState).planType;
    const plan = normalizePlanType(raw);
    if (!plan) return null;
    if (plan === 'self_serve_business_prolite') return t('codex_quota.plan_business_premium');
    if (plan === 'pro') return t('codex_quota.plan_pro');
    if (PREMIUM_CODEX_PLAN_TYPES.has(plan)) return t('codex_quota.plan_prolite');
    return ['plus', 'team', 'free'].includes(plan) ? t(`codex_quota.plan_${plan}`) : (raw ?? null);
  }
  if (type === 'claude') {
    const plan = (quota as ClaudeQuotaState).planType;
    return plan ? t(`claude_quota.${plan}`, { defaultValue: plan }) : null;
  }
  if (type === 'antigravity')
    return (quota as AntigravityQuotaState).subscription?.tierName ?? null;
  if (type === 'devin') return (quota as DevinQuotaState).plan;
  if (type === 'meta') return (quota as MetaQuotaState).data?.planName ?? null;
  if (type === 'xai') return (quota as XaiQuotaState).billing?.planLabel ?? null;
  return null;
}

export function ledgerRenewalMs(type: QuotaProviderType, quota?: QuotaCardState): number | null {
  if (quota?.status !== 'success') return null;
  if (type === 'codex') return resolveResetMs([(quota as CodexQuotaState).subscriptionActiveUntil]);
  if (type === 'devin') return (quota as DevinQuotaState).planEndMs;
  return null;
}

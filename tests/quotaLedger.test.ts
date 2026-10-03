import { describe, expect, test } from 'bun:test';
import type { ClaudeQuotaState, CodexQuotaState, XaiQuotaState } from '@/types';
import {
  aggregateLedgerWindow,
  ledgerDisplayName,
  ledgerWindows,
  primaryLedgerWindow,
  type LedgerWindow,
} from '@/features/quota/ledgerModel';

const now = Date.UTC(2026, 9, 3);
const window = (
  id: string,
  remaining: number | null,
  resetAtMs: number | null = null
): LedgerWindow => ({ id, remaining, resetAtMs });

describe('quota ledger totals', () => {
  test('adds remaining capacity, including exhausted accounts, with one segment per credential', () => {
    const total = aggregateLedgerWindow(
      [window('weekly', 0, now + 2000), window('weekly', 17, now + 1000), window('weekly', 100)],
      now
    );
    expect(total).toEqual({
      segments: [0, 17, 100],
      knownCount: 3,
      remaining: 117,
      capacity: 300,
      nextResetAtMs: now + 1000,
    });
  });
  test('keeps partial and failed observations unknown rather than presenting them as zero quota', () => {
    const total = aggregateLedgerWindow(
      [window('weekly', 60, now + 1000), undefined, window('weekly', null, now + 500)],
      now
    );
    expect(total.remaining).toBeNull();
    expect(total.knownCount).toBe(1);
    expect(total.capacity).toBe(300);
    expect(total.segments).toEqual([60, null, null]);
    expect(total.nextResetAtMs).toBe(now + 1000);
    expect(aggregateLedgerWindow([], now).remaining).toBeNull();
  });
  test('ignores expired and malformed reset timestamps and clamps upstream percentages', () => {
    const total = aggregateLedgerWindow(
      [window('weekly', -5, now - 1), window('weekly', 110, NaN), window('weekly', 20, now + 5000)],
      now
    );
    expect(total.remaining).toBe(120);
    expect(total.nextResetAtMs).toBe(now + 5000);
    expect(aggregateLedgerWindow([window('weekly', NaN)], now).remaining).toBeNull();
    expect(
      aggregateLedgerWindow([window('weekly', NaN, now + 1000)], now).nextResetAtMs
    ).toBeNull();
  });
  test('matches Fable across Claude accounts without combining the 5-hour and weekly limits', () => {
    const quota: ClaudeQuotaState = {
      status: 'success',
      windows: [
        { id: 'five-hour', label: '5-hour', usedPercent: 0, resetLabel: '-', periodHours: 5 },
        { id: 'seven-day', label: '7-day', usedPercent: 21, resetLabel: '-', periodHours: 168 },
        {
          id: 'seven-day-fable',
          label: 'Fable',
          usedPercent: 42,
          resetLabel: '-',
          periodHours: 168,
        },
      ],
    };
    const windows = ledgerWindows('claude', quota);
    expect(windows.map((item) => item.remaining)).toEqual([58, 100, 79]);
    expect(primaryLedgerWindow('claude', windows).id).toBe('seven-day-fable');
    expect(ledgerWindows('claude', { ...quota, status: 'loading' })).toEqual([]);
    expect(ledgerWindows('claude', { ...quota, status: 'error' })).toEqual([]);
  });
  test('picks the Codex weekly window, preserving a legitimate 0% remaining', () => {
    const quota: CodexQuotaState = {
      status: 'success',
      windows: [
        { id: 'five-hour', label: '5-hour', usedPercent: 10, resetLabel: '-' },
        { id: 'weekly', label: 'Weekly', usedPercent: 100, resetLabel: '-' },
        { id: 'code-review-weekly', label: 'Code review', usedPercent: 0, resetLabel: '-' },
      ],
    };
    const primary = primaryLedgerWindow('codex', ledgerWindows('codex', quota));
    expect(primary.id).toBe('weekly');
    expect(primary.remaining).toBe(0);
  });
  test('does not present xAI monthly billing or a health probe as weekly capacity', () => {
    const billing = {
      mode: 'billing',
      periodType: 'monthly',
      usagePercent: 25,
      resetAtMs: now + 1000,
    } as XaiQuotaState['billing'];
    expect(ledgerWindows('xai', { status: 'success', billing })).toEqual([]);
    expect(
      ledgerWindows('xai', {
        status: 'success',
        billing: { ...billing, mode: 'paid-health', periodType: 'weekly' },
      } as XaiQuotaState)
    ).toEqual([]);
  });
});
describe('quota ledger account privacy', () => {
  test('conceals international mailbox names as well as ASCII mailboxes', () => {
    expect(ledgerDisplayName({ name: 'claude-用户@例子.com.json' }, false)).toBe(
      'claude-用•••@例•••.com.json'
    );
  });
  test('masks complete mailboxes in provider filenames while retaining the provider, plan suffix and file extension', () => {
    const file = {
      name: 'codex-deadbeef-alice.smith@example.dev-pro.json',
      email: 'alice.smith@example.dev',
    };
    expect(ledgerDisplayName(file, false)).toBe('codex-deadbeef-a•••@e•••.dev-pro.json');
    expect(ledgerDisplayName(file, true)).toBe(file.name);
    expect(file.email).toBe('alice.smith@example.dev');
  });
  test('masks identity-aware Devin labels and never falls back to credential-bearing account fields', () => {
    const file = {
      name: 'devin.json',
      type: 'devin',
      email: 'alice@example.com',
      authIndex: 7,
      account: 'secret-api-key',
    };
    expect(ledgerDisplayName(file, false)).toBe('devin.json · a•••@e•••.com');
    expect(ledgerDisplayName({ ...file, email: undefined }, false)).toBe('devin.json · 7');
    expect(ledgerDisplayName({ name: 'plain.json', account: 'secret-api-key' }, false)).toBe(
      'plain.json'
    );
  });
});

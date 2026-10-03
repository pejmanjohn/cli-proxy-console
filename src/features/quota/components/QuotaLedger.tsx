import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import { useNow } from '@/hooks/useNow';
import type { CodexQuotaState, ResolvedTheme } from '@/types';
import { buildResetDisplay, parseIsoToMs, resolveQuotaErrorMessage } from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { getAuthFileIcon, getTypeLabel } from '@/features/authFiles/constants';
import { QUOTA_TAB_ORDER } from '../constants';
import {
  aggregateLedgerWindow,
  ledgerDisplayName,
  ledgerPlanLabel,
  ledgerRenewalMs,
  ledgerWindows,
  primaryLedgerWindow,
  type LedgerWindow,
} from '../ledgerModel';
import { isQuotaRefreshDisabled, type QuotaFileEntry } from '../logic';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';
import { useClaudeResetGrants } from '../providers/claude/ClaudeResetGrants';
import { bindQuotaClasses } from '../types';
import bodyStyles from './QuotaBody.module.scss';
import styles from './QuotaLedger.module.scss';

const quotaClasses = bindQuotaClasses(bodyStyles, 'QuotaBody.module.scss');
const fillClass = (remaining: number | null) =>
  remaining === null
    ? styles.unknown
    : remaining >= 70
      ? styles.high
      : remaining >= 30
        ? styles.medium
        : styles.low;

function ResetTime({
  atMs,
  label,
  now,
  fallback,
  absoluteFirst = false,
}: {
  atMs?: number | null;
  label?: string;
  now: number;
  fallback?: string;
  absoluteFirst?: boolean;
}) {
  const { i18n } = useTranslation();
  const display = buildResetDisplay(label, atMs, now, i18n.resolvedLanguage);
  return (
    <span className={styles.resetTime}>
      {display ? (
        <>
          {absoluteFirst && display.absolute}
          {display.relative && (
            <>
              {absoluteFirst && <span aria-hidden="true"> · </span>}
              {display.relative}
              {!absoluteFirst && <span aria-hidden="true"> · </span>}
            </>
          )}
          {!absoluteFirst && display.absolute}
        </>
      ) : (
        (fallback ?? '—')
      )}
    </span>
  );
}

function WindowMeter({ window, now }: { window: LedgerWindow; now: number }) {
  const { t } = useTranslation();
  const label = window.labelKey
    ? t(window.labelKey, window.labelParams)
    : (window.label ?? window.id);
  const percent = window.remaining;
  return (
    <div className={styles.window}>
      <div className={styles.windowHead}>
        <span>{label}</span>
        <strong>{percent === null ? '--' : `${Math.round(percent)}%`}</strong>
      </div>
      <div
        className={styles.track}
        role={percent === null ? undefined : 'meter'}
        aria-label={label}
        aria-valuemin={percent === null ? undefined : 0}
        aria-valuemax={percent === null ? undefined : 100}
        aria-valuenow={percent ?? undefined}
      >
        <span className={fillClass(percent)} style={{ width: `${percent ?? 0}%` }} />
      </div>
      <ResetTime
        atMs={window.resetAtMs}
        label={window.resetLabel}
        now={now}
        fallback={t(`quota_management.${percent === 100 ? 'no_reset_pending' : 'reset_unknown'}`)}
      />
    </div>
  );
}

function ProviderSummary({
  type,
  entries,
  quotaFor,
  resolvedTheme,
  now,
}: {
  type: QuotaProviderType;
  entries: QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  resolvedTheme: ResolvedTheme;
  now: number;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const observations = entries.map((entry) => ledgerWindows(type, quotaFor(entry)));
  const primary = primaryLedgerWindow(type, observations.flat());
  const total = aggregateLedgerWindow(
    observations.map((windows) => windows.find((window) => window.id === primary.id)),
    now
  );
  const secondary =
    type === 'claude' && primary.id !== 'seven-day'
      ? aggregateLedgerWindow(
          observations.map((windows) => windows.find((window) => window.id === 'seven-day')),
          now
        )
      : null;
  const icon = getAuthFileIcon(type, resolvedTheme);
  const segmentedBar = (segments: Array<number | null>) => (
    <div className={styles.segments} aria-hidden="true">
      {segments.map((percent, index) => (
        <span key={index} className={styles.segment}>
          <span className={fillClass(percent)} style={{ width: `${percent ?? 0}%` }} />
        </span>
      ))}
    </div>
  );
  return (
    <article className={styles.summaryCell}>
      <div className={styles.summaryHead}>
        <h2>
          {icon && <img src={icon} alt="" />}
          {getTypeLabel(t, type)}
        </h2>
        <span>{t('quota_management.meta_credentials', { count: entries.length })}</span>
      </div>
      <div className={styles.summaryLabel}>
        {primary.labelKey ? t(primary.labelKey, primary.labelParams) : primary.label}
      </div>
      <div className={styles.summaryValue}>
        <strong>{total.remaining === null ? '--' : `${Math.round(total.remaining)}%`}</strong>
        <span>{t('quota_management.of_capacity', { capacity: total.capacity })}</span>
      </div>
      {segmentedBar(total.segments)}
      <ResetTime
        atMs={total.nextResetAtMs}
        now={now}
        fallback={t(
          `quota_management.${total.remaining === total.capacity ? 'no_reset_pending' : 'reset_unknown'}`
        )}
      />
      {secondary && (
        <div className={styles.summarySecondary}>
          <div className={styles.secondaryHead}>
            <span>
              {t('claude_quota.seven_day')}{' '}
              <strong>
                {secondary.remaining === null ? '--' : `${Math.round(secondary.remaining)}%`}
              </strong>
            </span>
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
              aria-label={t('quota_management.secondary_details', {
                provider: getTypeLabel(t, type),
              })}
            >
              {t(`quota_management.${expanded ? 'hide' : 'show'}`)}
            </button>
          </div>
          {expanded && (
            <div className={styles.secondaryDetails}>
              {segmentedBar(secondary.segments)}
              <ResetTime
                atMs={secondary.nextResetAtMs}
                now={now}
                fallback={t('quota_management.reset_unknown')}
              />
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function AccountRow({
  entry,
  quota,
  showEmails,
  canRefresh,
  resetting,
  now,
  onRefresh,
  onReset,
}: {
  entry: QuotaFileEntry;
  quota?: QuotaCardState;
  showEmails: boolean;
  canRefresh: boolean;
  resetting: boolean;
  now: number;
  onRefresh: () => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const adapter = QUOTA_ADAPTERS[entry.type];
  const status = quota?.status ?? 'idle';
  const loading = status === 'loading';
  const displayName = ledgerDisplayName(entry.file, showEmails);
  const plan = ledgerPlanLabel(entry.type, quota, t);
  const renewal = ledgerRenewalMs(entry.type, quota);
  const windows = ledgerWindows(entry.type, quota);
  const codex = entry.type === 'codex' && status === 'success' ? (quota as CodexQuotaState) : null;
  const credits = codex?.rateLimitResetCredits ?? [];
  const claudeReset = useClaudeResetGrants(
    entry.file,
    entry.type === 'claude' && status !== 'idle',
    !canRefresh || loading || resetting,
    quota,
    onRefresh
  );
  const canReset = status === 'success' && quota && adapter.canResetQuota?.(quota);
  const hasManualResets =
    codex &&
    (codex.rateLimitResetCreditsAvailableCount != null ||
      credits.length > 0 ||
      codex.rateLimitResetCreditsError);
  const useExistingBody = entry.type !== 'claude' && entry.type !== 'codex';
  const errorMessage = resolveQuotaErrorMessage(
    t,
    quota?.errorStatus,
    quota?.error || t('common.unknown_error')
  );

  return (
    <article
      className={styles.accountRow}
      aria-label={displayName}
      aria-busy={loading || resetting}
    >
      <div className={styles.identity}>
        <h3 title={displayName}>{displayName}</h3>
        <div className={styles.plan}>
          {plan && <strong>{plan}</strong>}
          {renewal !== null && (
            <>
              {plan && <span aria-hidden="true"> · </span>}
              <span>{t('quota_management.renews')} </span>
              <ResetTime atMs={renewal} now={now} absoluteFirst />
            </>
          )}
        </div>
        {entry.type === 'claude' && claudeReset.count !== null && claudeReset.count > 0 && (
          <div className={styles.status}>
            {t('claude_reset.remaining')} {claudeReset.count}
          </div>
        )}
        {entry.file.disabled && (
          <span className={styles.status}>{t('dashboard.health_disabled')}</span>
        )}
      </div>
      <div className={styles.metrics}>
        {status === 'idle' ? (
          <span className={styles.status}>{t(`${adapter.i18nPrefix}.idle`)}</span>
        ) : loading ? (
          <span className={styles.status} role="status">
            {t(`${adapter.i18nPrefix}.loading`)}
          </span>
        ) : status === 'error' ? (
          <div className={styles.error} role="alert">
            {t(`${adapter.i18nPrefix}.load_failed`, { message: errorMessage })}
          </div>
        ) : useExistingBody && quota ? (
          <div className={styles.providerBody}>
            <adapter.Body quota={quota} classes={quotaClasses} />
          </div>
        ) : (
          <>
            {windows.map((window) => (
              <WindowMeter key={window.id} window={window} now={now} />
            ))}
            {windows.length === 0 && (
              <span className={styles.status}>{t(`${adapter.i18nPrefix}.empty_windows`)}</span>
            )}
            {hasManualResets && (
              <div className={styles.manualResets}>
                <span>{t('codex_quota.reset_credits_label')}</span>
                <div className={styles.available}>
                  <strong>{codex.rateLimitResetCreditsAvailableCount ?? '--'}</strong>{' '}
                  {t('quota_management.available')}
                </div>
                <div
                  className={styles.creditExpiries}
                  title={credits
                    .map(
                      (credit, index) =>
                        `${t('codex_quota.reset_credit_number', { index: index + 1 })}: ${buildResetDisplay(null, parseIsoToMs(credit.expiresAt), now)?.absolute ?? '—'}`
                    )
                    .join(', ')}
                >
                  {credits.map((credit, index) => (
                    <span key={credit.id || index} className={styles.creditExpiry}>
                      {index > 0 && ', '}
                      {t('codex_quota.reset_credit_number', { index: index + 1 })}
                      <span aria-hidden="true"> · </span>
                      <ResetTime atMs={parseIsoToMs(credit.expiresAt)} now={now} />
                    </span>
                  ))}
                </div>
                {codex.rateLimitResetCreditsError && (
                  <div className={styles.error} role="status">
                    {t('codex_quota.reset_credits_expiry_failed', {
                      message: codex.rateLimitResetCreditsError,
                    })}
                  </div>
                )}
              </div>
            )}
            {claudeReset.message && entry.type === 'claude' && (
              <div className={styles.status} role="status">
                {t(`claude_reset.${claudeReset.message}`)}
              </div>
            )}
          </>
        )}
      </div>
      <div
        className={`${styles.rowActions} ${entry.type === 'claude' ? styles.claudeActions : ''}`}
      >
        {entry.type === 'claude' &&
          status === 'success' &&
          claudeReset.count !== null &&
          claudeReset.count > 0 && (
            <button type="button" onClick={claudeReset.confirm} disabled={claudeReset.blocked}>
              <IconRefreshCw
                size={13}
                aria-hidden="true"
                className={claudeReset.busy ? styles.spinning : undefined}
              />
              {t(`claude_reset.${claudeReset.buttonLabel}`)}
            </button>
          )}
        {(hasManualResets || canReset) && (
          <button
            type="button"
            onClick={onReset}
            disabled={!canReset || !canRefresh || loading || resetting}
            aria-label={`${t('codex_quota.reset_button')} · ${displayName}`}
          >
            <IconRefreshCw
              size={13}
              aria-hidden="true"
              className={resetting ? styles.spinning : undefined}
            />
            {t('codex_quota.reset_button')}
          </button>
        )}
        <button
          type="button"
          onClick={onRefresh}
          disabled={isQuotaRefreshDisabled(canRefresh, loading, resetting || claudeReset.busy)}
          aria-label={`${t('auth_files.quota_refresh_single')} · ${displayName}`}
        >
          <IconRefreshCw
            size={13}
            aria-hidden="true"
            className={loading ? styles.spinning : undefined}
          />
          {t('auth_files.quota_refresh_single')}
        </button>
      </div>
    </article>
  );
}

export interface QuotaLedgerProps {
  entries: QuotaFileEntry[];
  /** Totals cover every matching credential, including accounts on other pages. */
  summaryEntries: QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  resolvedTheme: ResolvedTheme;
  showEmails: boolean;
  canRefresh: boolean;
  resettingQuotaName: string | null;
  onRefresh: (entry: QuotaFileEntry) => void;
  onReset: (entry: QuotaFileEntry) => void;
}

export function QuotaLedger(props: QuotaLedgerProps) {
  const { t } = useTranslation();
  const now = useNow();
  const types = QUOTA_TAB_ORDER.filter((type) =>
    props.summaryEntries.some((entry) => entry.type === type)
  );
  return (
    <div className={styles.ledger}>
      <section className={styles.summary} aria-label={t('quota_management.provider_totals')}>
        {types.map((type) => (
          <ProviderSummary
            key={type}
            type={type}
            entries={props.summaryEntries.filter((entry) => entry.type === type)}
            quotaFor={props.quotaFor}
            resolvedTheme={props.resolvedTheme}
            now={now}
          />
        ))}
      </section>
      <div className={styles.groups}>
        {types.map((type) => {
          const entries = props.entries.filter((entry) => entry.type === type);
          if (!entries.length) return null;
          return (
            <section key={type} className={styles.group} aria-label={getTypeLabel(t, type)}>
              <h2 className={styles.groupTitle}>
                {getTypeLabel(t, type)}{' '}
                <span>{props.summaryEntries.filter((entry) => entry.type === type).length}</span>
              </h2>
              {entries.map((entry) => (
                <AccountRow
                  key={getQuotaCacheKey(entry.file)}
                  entry={entry}
                  quota={props.quotaFor(entry)}
                  showEmails={props.showEmails}
                  canRefresh={props.canRefresh && !entry.file.disabled}
                  resetting={props.resettingQuotaName === getQuotaCacheKey(entry.file)}
                  now={now}
                  onRefresh={() => props.onRefresh(entry)}
                  onReset={() => props.onReset(entry)}
                />
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

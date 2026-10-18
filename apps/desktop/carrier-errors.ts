import { carrierIssue, type CarrierIssue } from '../../packages/carrier/errors.ts';
import { redactSecrets } from '../../packages/platform/redact.ts';
import { mainText, translate } from './i18n.ts';
import type { UiLanguage } from './ui-settings.ts';
import type { DesktopReply } from './contract.ts';

/** Shared by the main-process reply and the renderer, which can change language after receiving it. */
export function carrierErrorText(
  failure: { error: string | null; errorDetail?: CarrierIssue | null },
  language: UiLanguage,
): string {
  if (!failure.errorDetail) return failure.error ?? '';
  const key = `carrier.${failure.errorDetail.code}`;
  const text = translate(key, language, failure.errorDetail.values);
  return text === key ? (failure.error ?? '') : text;
}

export function carrierErrorReply(error: unknown): Extract<DesktopReply, { ok: false }> {
  const detail = carrierIssue(error, redactSecrets);
  const fallback = redactSecrets(
    error instanceof Error ? error.message : 'Desktop operation failed',
  );
  return {
    ok: false,
    error: detail ? mainText(`carrier.${detail.code}`, detail.values) : fallback,
    ...(detail ? { errorDetail: detail } : {}),
  };
}

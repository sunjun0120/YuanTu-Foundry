import { translate } from './i18n.ts';

/**
 * The one sentence a person reads for a failure that has a known shape.
 *
 * The banner used to print the kernel's own English string verbatim — for a wrong key that was
 * `Model API returned HTTP 401: Authentication Fails, Your api key: ****test is invalid (request_id: …)`, which
 * names a request id the reader cannot use and never mentions where the key lives. This maps the errors a
 * desktop user actually meets onto a sentence that says what happened and what to do; the kernel's text stays
 * available as the banner's tooltip and in the session log.
 *
 * Deliberately narrow: an unrecognised error is returned as it came, because inventing a friendly sentence for
 * an unknown failure is how a real cause gets lost.
 */
export const SETTINGS_HINT_ZH = '请到“设置 → 模型设置”检查接口地址和密钥。';
export const SETTINGS_HINT_EN = 'Check the endpoint and key in Settings → Model settings.';

function httpFailure(error: string, english: boolean): string | null {
  const match = /^Model API returned HTTP (\d{3})\b/.exec(error);
  if (!match) return null;
  const status = Number(match[1]);
  if (status === 401 || status === 403)
    return english
      ? `The model endpoint rejected the credential (HTTP ${status}). ${SETTINGS_HINT_EN}`
      : `模型接口拒绝了这次请求的凭据（HTTP ${status}）。${SETTINGS_HINT_ZH}`;
  if (status === 404)
    return english
      ? `The model endpoint does not exist (HTTP 404). ${SETTINGS_HINT_EN}`
      : `模型接口地址不存在（HTTP 404）。${SETTINGS_HINT_ZH}`;
  if (status === 429)
    return english
      ? 'The model endpoint is rate-limiting requests (HTTP 429). Wait a moment and try again, or switch models.'
      : '模型接口正在限流（HTTP 429）。稍等片刻再试，或在模型选择器里换一个模型。';
  if (status >= 500)
    return english
      ? `The model endpoint failed on its side (HTTP ${status}). Try again, or switch models.`
      : `模型接口服务端出错（HTTP ${status}）。可以重试，或在模型选择器里换一个模型。`;
  return english
    ? `The model endpoint refused the request (HTTP ${status}). ${SETTINGS_HINT_EN}`
    : `模型接口拒绝了这次请求（HTTP ${status}）。${SETTINGS_HINT_ZH}`;
}

/** The sentence to show in the banner, or `null` when this error has no known shape. */
export function localizedRunError(error: string, english: boolean): string | null {
  const key = /partial answer; request was not re-sent/.test(error)
    ? 'ui.toolArgumentsPartial'
    : /does not accept disabling parallel tool calls/.test(error)
      ? 'ui.toolArgumentsUnsupported'
      : /parallel tool calls disabled; still missing/.test(error)
        ? 'ui.toolArgumentsRecoveryFailed'
        : null;
  return key ? translate(key, english ? 'en-US' : 'zh-CN') : httpFailure(error, english);
}

/**
 * Whether the fix for this error lives in the model settings, so the banner can offer to open them.
 *
 * The 401 sentence told the person to go to 设置 → 模型设置 while the banner itself could not be clicked. Rate
 * limits and server errors are not settings problems, so they get no button.
 */
export function runErrorWantsModelSettings(error: string): boolean {
  const match = /^Model API returned HTTP (\d{3})\b/.exec(error);
  if (!match) return false;
  const status = Number(match[1]);
  return status !== 429 && status < 500;
}

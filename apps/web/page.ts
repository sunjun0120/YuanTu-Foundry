/**
 * The page's entry point.
 *
 * Two lines of work, in this order, and the order is the point: the bridge has to exist on `window` *before* the
 * desktop's renderer module is imported, because that module is written against `window.yuantu: DesktopBridge`
 * and starts rendering as it loads. That is the whole reuse story — the renderer, its sibling modules and the
 * slots know nothing about which carrier is under them.
 */
import { createBrowserBridge } from './bridge-client.ts';
import type { DesktopBridge } from '../desktop/contract.ts';

const token = new URLSearchParams(location.search).get('token');
if (!token) {
  document.body.textContent =
    '缺少访问令牌。请用桥打印的地址打开页面（apps/web/main.ts 启动时会输出完整 URL）。';
} else {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${scheme}://${location.host}/ws?token=${encodeURIComponent(token)}`;
  (window as unknown as { yuantu: DesktopBridge }).yuantu = createBrowserBridge({ url });
  await import('../desktop/renderer.ts');
}

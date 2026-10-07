import type { McpServer, McpServerView, McpView, McpReply } from './mcp-contract.ts';
import { showSettingsPanel } from './renderer-panels.ts';
import { onLocaleChange, t } from './i18n.ts';
export function setupMcpSettings(
  isBusy: () => boolean,
  onBusy: (busy: boolean) => void,
  workspace: () => string | undefined,
): { updateBusy(): void } {
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const page = byId('settings-page');
  const nav = document.createElement('button');
  nav.id = 'mcp-settings';
  nav.type = 'button';
  nav.replaceChildren();
  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '◇';
  nav.append(icon, document.createTextNode(t('mcp.title')));
  onLocaleChange(() => {
    nav.lastChild!.textContent = t('mcp.title');
  });
  page.querySelector('nav')!.append(nav);
  const panel = document.createElement('section');
  panel.className = 'settings-content mcp-content';
  panel.hidden = true;
  panel.id = 'mcp-panel';
  panel.setAttribute('aria-labelledby', 'mcp-title');
  panel.innerHTML = `<div class="settings-page-header"><div class="eyebrow">PREFERENCES / MCP</div><h2 id="mcp-title">MCP 服务</h2><p>连接外部工具，扩展当前工作区的能力。</p></div>
 <div class="mcp-workspace" id="mcp-workspace"></div>
 <div class="mcp-service-picker"><label for="mcp-list">已配置的服务</label><select id="mcp-list"></select><div class="settings-actions"><button id="mcp-new" type="button" class="secondary">添加服务</button><button id="mcp-reload" type="button" class="secondary">重新加载</button></div></div>
 <form id="mcp-form"><label for="mcp-id">服务名称</label><input id="mcp-id" pattern="[a-z][a-z0-9_]{0,31}" maxlength="32" required placeholder="例如：project_tools" /><small id="mcp-name-note">使用小写字母、数字和下划线，名称以字母开头。</small>
 <label for="mcp-transport">连接方式</label><select id="mcp-transport"><option value="stdio">本地进程（stdio）</option><option value="http">Streamable HTTP</option><option value="sse">SSE</option></select>
 <div id="mcp-local"><label for="mcp-command">启动命令</label><input id="mcp-command" placeholder="node 或可执行文件路径" maxlength="4096" /><label for="mcp-args">启动参数</label><textarea id="mcp-args" rows="3" placeholder="每行一个参数"></textarea><label for="mcp-cwd">工作目录</label><input id="mcp-cwd" placeholder=".（当前工作区）" maxlength="4096" /><label for="mcp-env">环境变量（JSON）</label><textarea id="mcp-env" rows="3" spellcheck="false" placeholder='{"API_TOKEN":"\${MCP_TOKEN}"}'></textarea></div>
 <div id="mcp-remote" hidden><label for="mcp-url">服务地址</label><input id="mcp-url" type="url" placeholder="https://example.com/mcp" maxlength="4096" /><label for="mcp-headers">请求头（JSON）</label><textarea id="mcp-headers" rows="3" spellcheck="false" placeholder='{"Authorization":"Bearer \${MCP_TOKEN}"}'></textarea>
 <fieldset id="mcp-oauth" class="mcp-oauth"><legend>OAuth 授权</legend><label class="mcp-oauth-enabled"><input id="mcp-oauth-enabled" type="checkbox" />使用 OAuth 授权</label>
 <div id="mcp-oauth-fields" hidden><label for="mcp-oauth-scopes">授权范围</label><input id="mcp-oauth-scopes" maxlength="1024" placeholder="留空表示由服务端决定" /><small id="mcp-oauth-scopes-note">多个范围用逗号或空格分隔；留空表示由服务端决定。</small>
 <label for="mcp-oauth-client-id">客户端 ID</label><input id="mcp-oauth-client-id" maxlength="4096" placeholder="留空则自动注册客户端" />
 <label for="mcp-oauth-client-secret">客户端密钥</label><input id="mcp-oauth-client-secret" maxlength="4096" placeholder="\${MCP_CLIENT_SECRET}" /><small id="mcp-oauth-secret-note">仅接受 \${ENV_VAR} 形式的环境变量占位符，不会保存明文密钥。</small>
 <label for="mcp-oauth-client-name">客户端名称</label><input id="mcp-oauth-client-name" maxlength="4096" placeholder="YuanTu Agent" />
 <label for="mcp-oauth-redirect-port">回调端口</label><input id="mcp-oauth-redirect-port" type="number" min="1024" max="65535" step="1" placeholder="自动选择" />
 <p id="mcp-oauth-status" class="mcp-oauth-status" role="status" aria-live="polite"></p>
 <div class="settings-actions"><button id="mcp-authorize" type="button" class="secondary">授权</button><button id="mcp-revoke" type="button" class="secondary">撤销授权</button></div></div></fieldset></div>
 <label class="mcp-enabled"><input id="mcp-enabled" type="checkbox" checked />启用此服务</label>
 <p class="mcp-note">密钥请使用环境变量引用；更改环境变量后需重启桌面。测试会连接服务或启动本地进程，仅发现工具，不调用工具。</p>
 <p id="mcp-feedback" class="settings-feedback" role="status" aria-live="polite" hidden></p>
 <div class="settings-actions"><button id="mcp-test" type="button" class="secondary">测试连接</button><button id="mcp-save" type="submit" class="primary">保存服务</button><button id="mcp-delete" type="button" class="secondary">删除服务</button></div>
 <div id="mcp-delete-confirm" hidden><p>删除此服务配置？下一轮对话将不再加载它。</p><button id="mcp-delete-yes" type="button" class="secondary">确认删除</button><button id="mcp-delete-no" type="button" class="secondary">取消</button></div></form>`;
  page.append(panel);
  const form = byId<HTMLFormElement>('mcp-form'),
    list = byId<HTMLSelectElement>('mcp-list'),
    id = byId<HTMLInputElement>('mcp-id'),
    transport = byId<HTMLSelectElement>('mcp-transport');
  let knownWorkspace: string | undefined;
  let view: McpView | undefined,
    editing: string | undefined,
    pending = false,
    authorizing = false;
  const translate = () => {
    const text = (selector: string, key: string) => {
      const node = panel.querySelector<HTMLElement>(selector);
      if (!node) return;
      const textNode = [...node.childNodes].find((child) => child.nodeType === Node.TEXT_NODE);
      if (textNode) textNode.textContent = t(key);
      else node.append(document.createTextNode(t(key)));
    };
    const attr = (selector: string, name: string, key: string) => {
      const node = panel.querySelector<HTMLElement>(selector);
      if (node) node.setAttribute(name, t(key));
    };
    text('#mcp-title', 'mcp.title');
    text('.settings-page-header p', 'mcp.description');
    text('label[for="mcp-list"]', 'mcp.configured');
    text('#mcp-new', 'mcp.add');
    text('#mcp-reload', 'mcp.reload');
    text('label[for="mcp-id"]', 'mcp.name');
    text('#mcp-name-note', 'mcp.nameNote');
    text('label[for="mcp-transport"]', 'mcp.transport');
    text('#mcp-local label[for="mcp-command"]', 'mcp.command');
    text('#mcp-local label[for="mcp-args"]', 'mcp.args');
    text('#mcp-local label[for="mcp-cwd"]', 'mcp.cwd');
    text('#mcp-local label[for="mcp-env"]', 'mcp.env');
    text('#mcp-remote label[for="mcp-url"]', 'mcp.url');
    text('#mcp-remote label[for="mcp-headers"]', 'mcp.headers');
    text('#mcp-oauth legend', 'mcp.oauthSection');
    text('.mcp-oauth-enabled', 'mcp.oauthEnabled');
    text('#mcp-remote label[for="mcp-oauth-scopes"]', 'mcp.oauthScopes');
    text('#mcp-oauth-scopes-note', 'mcp.oauthScopesNote');
    text('#mcp-remote label[for="mcp-oauth-client-id"]', 'mcp.oauthClientId');
    text('#mcp-remote label[for="mcp-oauth-client-secret"]', 'mcp.oauthClientSecret');
    text('#mcp-oauth-secret-note', 'mcp.oauthClientSecretNote');
    text('#mcp-remote label[for="mcp-oauth-client-name"]', 'mcp.oauthClientName');
    text('#mcp-remote label[for="mcp-oauth-redirect-port"]', 'mcp.oauthRedirectPort');
    text('#mcp-authorize', 'mcp.authorize');
    text('#mcp-revoke', 'mcp.revoke');
    text('.mcp-enabled', 'mcp.enabled');
    text('.mcp-note', 'mcp.note');
    text('#mcp-test', 'mcp.test');
    text('#mcp-save', 'mcp.save');
    text('#mcp-delete', 'mcp.delete');
    text('#mcp-delete-confirm p', 'mcp.deletePrompt');
    text('#mcp-delete-yes', 'mcp.confirmDelete');
    text('#mcp-delete-no', 'ui.cancel');
    const stdio = panel.querySelector<HTMLOptionElement>('#mcp-transport option[value="stdio"]');
    if (stdio) stdio.textContent = t('mcp.localProcess');
    attr('#mcp-id', 'placeholder', 'mcp.namePlaceholder');
    attr('#mcp-command', 'placeholder', 'mcp.commandPlaceholder');
    attr('#mcp-args', 'placeholder', 'mcp.argsPlaceholder');
    attr('#mcp-cwd', 'placeholder', 'mcp.cwdPlaceholder');
    attr('#mcp-oauth-scopes', 'placeholder', 'mcp.oauthScopesPlaceholder');
    attr('#mcp-oauth-client-id', 'placeholder', 'mcp.oauthClientIdPlaceholder');
    attr('#mcp-oauth-client-secret', 'placeholder', 'mcp.oauthClientSecretPlaceholder');
    attr('#mcp-oauth-client-name', 'placeholder', 'mcp.oauthClientNamePlaceholder');
    attr('#mcp-oauth-redirect-port', 'placeholder', 'mcp.oauthRedirectPortPlaceholder');
    nav.lastChild!.textContent = t('mcp.title');
    if (view) render(view, editing);
  };
  onLocaleChange(translate);
  translate();
  const status = (message: string, error = false) => {
    const node = byId('mcp-feedback');
    node.textContent = message;
    node.hidden = !message;
    node.dataset.error = String(error);
  };
  const value = (name: string) => byId<HTMLInputElement | HTMLTextAreaElement>('mcp-' + name).value;
  const set = (name: string, value: string) => {
    byId<HTMLInputElement | HTMLTextAreaElement>('mcp-' + name).value = value;
  };
  function savedServer(): McpServerView | undefined {
    return view?.servers.find((server) => server.id === editing && server.id === id.value);
  }
  function oauthStatus() {
    const node = byId('mcp-oauth-status');
    if (transport.value === 'stdio') {
      node.textContent = '';
      return;
    }
    const saved = savedServer();
    if (!saved?.oauth) {
      node.textContent = t('mcp.oauthMissing');
      return;
    }
    if (!saved.authorized) {
      node.textContent = t('mcp.oauthNotAuthorized');
      return;
    }
    node.textContent = saved.expiresAt
      ? t('mcp.oauthAuthorizedUntil', { time: saved.expiresAt })
      : t('mcp.oauthAuthorized');
  }
  function updateBusy() {
    const current = workspace();
    if (current && current !== knownWorkspace) {
      knownWorkspace = current;
      view = undefined;
      editing = undefined;
      list.replaceChildren();
      id.value = '';
      id.readOnly = false;
      byId('mcp-workspace').textContent = '当前工作区：' + current;
      if (!panel.hidden) queueMicrotask(() => void refresh());
    }
    const blocked = pending || isBusy();
    for (const field of panel.querySelectorAll<
      HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement
    >('input,button,select,textarea'))
      field.disabled = blocked;
    byId<HTMLButtonElement>('mcp-delete').disabled = blocked || !editing;
    byId<HTMLButtonElement>('mcp-save').disabled = blocked || !view;
    byId<HTMLButtonElement>('mcp-test').disabled = blocked || !view;
    const authorized = savedServer();
    const authorize = byId<HTMLButtonElement>('mcp-authorize');
    if (authorizing) {
      authorize.textContent = t('mcp.cancelAuthorize');
      authorize.disabled = false;
    } else {
      authorize.textContent = t('mcp.authorize');
      authorize.disabled =
        blocked ||
        !authorized ||
        authorized.disabled ||
        transport.value === 'stdio' ||
        !byId<HTMLInputElement>('mcp-enabled').checked;
    }
    byId<HTMLButtonElement>('mcp-revoke').disabled =
      blocked || !authorized?.oauth || !authorized.authorized || authorizing;
    nav.disabled = blocked;
  }
  function mode() {
    const local = transport.value === 'stdio';
    byId('mcp-local').hidden = !local;
    byId('mcp-remote').hidden = local;
    byId('mcp-oauth').hidden = local;
    byId('mcp-oauth-fields').hidden = !byId<HTMLInputElement>('mcp-oauth-enabled').checked;
    byId<HTMLInputElement>('mcp-command').required = local;
    byId<HTMLInputElement>('mcp-url').required = !local;
  }
  function fill(server?: McpServer) {
    editing = server?.id;
    id.value = server?.id ?? '';
    id.readOnly = !!editing;
    transport.value = server?.transport ?? 'stdio';
    set('command', server?.command ?? '');
    set('args', server?.args?.join('\n') ?? '');
    set('cwd', server?.cwd ?? '.');
    set('env', server?.env ? JSON.stringify(server.env, null, 2) : '');
    set('url', server?.url ?? '');
    set('headers', server?.headers ? JSON.stringify(server.headers, null, 2) : '');
    byId<HTMLInputElement>('mcp-oauth-enabled').checked = Boolean(server?.oauth);
    set('oauth-scopes', server?.oauth?.scopes?.join(', ') ?? '');
    set('oauth-client-id', server?.oauth?.clientId ?? '');
    set('oauth-client-secret', server?.oauth?.clientSecret ?? '');
    set('oauth-client-name', server?.oauth?.clientName ?? '');
    set('oauth-redirect-port', server?.oauth?.redirectPort?.toString() ?? '');
    byId<HTMLInputElement>('mcp-enabled').checked = server?.disabled !== true;
    byId('mcp-delete-confirm').hidden = true;
    mode();
    updateBusy();
    oauthStatus();
  }
  function render(next: McpView, selected?: string) {
    view = next;
    byId('mcp-workspace').textContent = '当前工作区：' + next.workspace;
    list.replaceChildren();
    list.add(new Option(next.servers.length ? t('mcp.addNew') : t('mcp.empty'), ''));
    for (const server of next.servers)
      list.add(
        new Option(
          server.id + (server.disabled ? ' · 已停用' : '') + ' · ' + server.transport,
          server.id,
        ),
      );
    list.value = selected ?? '';
    fill(next.servers.find((server) => server.id === selected));
  }
  async function refresh() {
    try {
      const reply = await window.yuantu.mcp({ type: 'get' });
      if (reply.ok && reply.view) {
        if (workspace() && reply.view.workspace !== workspace()) return;
        render(reply.view, editing);
        status('');
      } else if (!reply.ok) {
        view = undefined;
        updateBusy();
        status(reply.error, true);
      }
    } catch {
      status('无法读取 MCP 配置，请重试。', true);
    }
  }
  function show(mcp: boolean) {
    showSettingsPanel(mcp ? 'mcp-panel' : 'model-settings-content');
    if (mcp) void refresh();
  }
  nav.addEventListener('click', () => show(true));
  byId('model-settings').addEventListener('click', () => show(false));
  byId('open-settings').addEventListener('click', () => {
    if (!panel.hidden) void refresh();
  });
  list.addEventListener('change', () => {
    fill(view?.servers.find((server) => server.id === list.value));
    status('');
  });
  byId('mcp-new').addEventListener('click', () => {
    list.value = '';
    fill();
    status('');
    id.focus();
  });
  byId('mcp-reload').addEventListener('click', () => void refresh());
  transport.addEventListener('change', () => {
    mode();
    updateBusy();
    oauthStatus();
  });
  byId('mcp-oauth-enabled').addEventListener('change', () => {
    mode();
    updateBusy();
  });
  const dictionary = (name: string) => {
    const raw = value(name).trim();
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.values(parsed).some((item) => typeof item !== 'string')
    )
      throw new Error('环境变量和请求头必须是字符串键值 JSON 对象。');
    return parsed as Record<string, string>;
  };
  function oauthDraft(): { oauth?: NonNullable<McpServer['oauth']> } {
    if (!byId<HTMLInputElement>('mcp-oauth-enabled').checked) return {};
    const oauth: NonNullable<McpServer['oauth']> = {};
    const scopes = value('oauth-scopes')
      .split(/[\s,]+/)
      .map((scope) => scope.trim())
      .filter(Boolean);
    if (scopes.length) oauth.scopes = [...new Set(scopes)];
    const clientId = value('oauth-client-id').trim();
    if (clientId) oauth.clientId = clientId;
    const secret = value('oauth-client-secret').trim();
    if (secret) {
      if (!/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(secret))
        throw new Error('客户端密钥必须写成 ${ENV_VAR} 形式的环境变量占位符。');
      oauth.clientSecret = secret;
    }
    const clientName = value('oauth-client-name').trim();
    if (clientName) oauth.clientName = clientName;
    const port = value('oauth-redirect-port').trim();
    if (port) {
      const parsed = Number(port);
      if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535)
        throw new Error('回调端口必须是 1024 到 65535 之间的整数。');
      oauth.redirectPort = parsed;
    }
    return { oauth };
  }
  function draft(): McpServer {
    const base = { id: id.value, disabled: !byId<HTMLInputElement>('mcp-enabled').checked };
    return transport.value === 'stdio'
      ? {
          ...base,
          transport: 'stdio',
          command: value('command'),
          args: value('args').split(/\r?\n/).filter(Boolean),
          cwd: value('cwd') || '.',
          env: dictionary('env'),
        }
      : {
          ...base,
          transport: transport.value as 'http' | 'sse',
          url: value('url'),
          headers: dictionary('headers'),
          ...oauthDraft(),
        };
  }
  async function action(type: 'test' | 'save' | 'delete') {
    if (pending || isBusy() || (type !== 'delete' && !form.reportValidity())) return;
    let server: McpServer;
    try {
      server = type === 'delete' ? { id: editing!, transport: 'stdio' } : draft();
    } catch (error) {
      status(error instanceof Error ? error.message : '配置格式错误。', true);
      return;
    }
    pending = true;
    onBusy(true);
    updateBusy();
    status(type === 'test' ? '正在连接并发现工具…' : '正在保存配置…');
    try {
      let reply: McpReply;
      if (type === 'test')
        reply = await window.yuantu.mcp({ type, server, revision: view!.revision });
      else if (!view) throw new Error('请先重新加载配置。');
      else
        reply = await window.yuantu.mcp(
          type === 'save'
            ? { type, server, revision: view.revision }
            : { type, id: editing!, revision: view.revision },
        );
      if (!reply.ok) {
        status(reply.error, true);
        return;
      }
      if (reply.view) render(reply.view, type === 'save' ? server.id : undefined);
      status(reply.message ?? '操作完成。');
    } catch (error) {
      status(error instanceof Error ? error.message : 'MCP 操作失败。', true);
    } finally {
      pending = false;
      onBusy(false);
      updateBusy();
    }
  }
  /**
   * Authorization always uses the saved configuration: the revision guard in the settings store
   * only protects `.yuantu/mcp.json`, so an unsaved draft must not drive the browser flow.
   */
  async function authorize() {
    const saved = savedServer();
    if (pending || isBusy() || !view || !saved) return;
    const { authorized, expiresAt, scopes, ...config } = saved;
    if (!config.oauth) {
      status(t('mcp.oauthMissing'), true);
      return;
    }
    pending = true;
    authorizing = true;
    onBusy(true);
    updateBusy();
    status(t('mcp.oauthPending'));
    try {
      const reply = await window.yuantu.mcp({
        type: 'authorize',
        server: config,
        revision: view.revision,
      });
      if (!reply.ok) {
        status(/cancel/i.test(reply.error) ? t('mcp.oauthCancelled') : reply.error, true);
        return;
      }
      if (reply.view) render(reply.view, editing);
      status(reply.message ?? t('mcp.oauthAuthorized'));
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      status(
        /cancel/i.test(message) ? t('mcp.oauthCancelled') : message || t('mcp.oauthFailed'),
        true,
      );
    } finally {
      pending = false;
      authorizing = false;
      onBusy(false);
      updateBusy();
    }
  }
  async function cancelAuthorize() {
    try {
      const reply = await window.yuantu.mcp({ type: 'cancel-authorize' });
      if (!reply.ok) status(reply.error, true);
    } catch (error) {
      status(error instanceof Error ? error.message : t('mcp.oauthFailed'), true);
    }
  }
  async function revoke() {
    const saved = savedServer();
    if (pending || isBusy() || !view || !saved) return;
    pending = true;
    onBusy(true);
    updateBusy();
    status(t('mcp.revoking'));
    try {
      const reply = await window.yuantu.mcp({
        type: 'revoke',
        id: saved.id,
        revision: view.revision,
      });
      if (!reply.ok) {
        status(reply.error, true);
        return;
      }
      if (reply.view) render(reply.view, editing);
      status(reply.message ?? t('mcp.revoked'));
    } catch (error) {
      status(error instanceof Error ? error.message : t('mcp.oauthFailed'), true);
    } finally {
      pending = false;
      onBusy(false);
      updateBusy();
    }
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void action('save');
  });
  byId('mcp-test').addEventListener('click', () => void action('test'));
  byId('mcp-delete').addEventListener('click', () => {
    byId('mcp-delete-confirm').hidden = false;
  });
  byId('mcp-delete-no').addEventListener('click', () => {
    byId('mcp-delete-confirm').hidden = true;
  });
  byId('mcp-delete-yes').addEventListener('click', () => void action('delete'));
  byId('mcp-authorize').addEventListener('click', () => {
    if (authorizing) void cancelAuthorize();
    else void authorize();
  });
  byId('mcp-revoke').addEventListener('click', () => void revoke());
  fill();
  return { updateBusy };
}

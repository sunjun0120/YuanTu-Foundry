import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgent, metadataWritesAllowed } from '../apps/shared/runtime.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { executionPolicy } from '../packages/tools/execution-policy.ts';
import type { ExecutionPolicy } from '../packages/protocol/execution.ts';
import { frames, httpFixture, sendFrames, systemText } from './http-fixture.ts';
import { nativeSkip } from './native-platform.ts';

test('host read-only policy cannot create workspace metadata', () => {
  assert.equal(
    metadataWritesAllowed({ YUANTU_SANDBOX: 'host', YUANTU_SANDBOX_FILES: 'read-only' }),
    false,
  );
});

test('worktree metadata follows the file policy, not the sandbox backend', () => {
  assert.equal(
    metadataWritesAllowed({ YUANTU_SANDBOX: 'native', YUANTU_SANDBOX_FILES: 'read-only' }),
    false,
  );
  assert.equal(
    metadataWritesAllowed({ YUANTU_SANDBOX: 'native', YUANTU_SANDBOX_FILES: 'workspace-write' }),
    true,
  );
});

for (const scenario of [
  {
    name: 'an explicitly selected host session overrides a native process default',
    environment: 'native',
    selected: 'host',
    allowed: true,
  },
  {
    name: 'a native session with workspace-write allocates an isolated worktree',
    environment: 'host',
    selected: 'native',
    allowed: true,
  },
  {
    name: 'revoking write access after agent construction also revokes workspace creation',
    environment: 'host',
    selected: 'native',
    files: 'read-only',
    allowed: false,
  },
  {
    name: 'read-only session policy prevents worktree creation under a host process',
    environment: 'host',
    selected: 'host',
    files: 'read-only',
    allowed: false,
  },
] as const) {
  test(
    scenario.name,
    { skip: 'selected' in scenario && scenario.selected === 'native' ? nativeSkip : false },
    async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), 'yuantu-workspace-policy-'));
      const state = `${root}-state`;
      const store = new SessionStore(path.join(state, 'sessions.sqlite'));
      t.after(async () => {
        store.close();
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
        await rm(state, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
      });
      const git = (...args: string[]) =>
        execFileSync('git', args, {
          cwd: root,
          encoding: 'utf8',
          windowsHide: true,
          env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
            GIT_AUTHOR_NAME: 'Test',
            GIT_AUTHOR_EMAIL: 'test@example.com',
            GIT_COMMITTER_NAME: 'Test',
            GIT_COMMITTER_EMAIL: 'test@example.com',
          },
        });
      git('init', '-q', '-b', 'main');
      await writeFile(path.join(root, 'source.txt'), 'unchanged\n');
      await writeFile(path.join(root, '.git', 'info', 'exclude'), '.yuantu/\n');
      git('add', '-A');
      git('commit', '-qm', 'initial');
      let parents = 0;
      let children = 0;
      const url = await httpFixture(t, (body, response) => {
        if (systemText(body.system).includes('You are a sub-agent delegated by a parent agent')) {
          children++;
          sendFrames(
            response,
            frames('', [
              {
                id: 'report',
                name: 'submit_report',
                input: {
                  summary: 'Complete',
                  findings: [
                    { statement: 'Isolated workspace is available', evidence: 'observed' },
                  ],
                },
              },
            ]),
          );
        } else if (++parents === 1) {
          sendFrames(
            response,
            frames('', [
              {
                id: 'delegate',
                name: 'delegate_task',
                input: { tasks: [{ objective: 'Inspect the isolated source', role: 'general' }] },
              },
            ]),
          );
        } else sendFrames(response, frames('Finished'));
      });
      const env = {
        YUANTU_SANDBOX: scenario.environment,
        YUANTU_SANDBOX_FILES: 'workspace-write',
        YUANTU_SUBAGENT_WORKSPACE: 'auto',
        YUANTU_PROTOCOL: 'anthropic',
        YUANTU_BASE_URL: url,
        YUANTU_MODEL: 'fixture',
        YUANTU_API_KEY: 'fixture',
        YUANTU_MAX_CONTEXT_TOKENS: '128000',
      };
      const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
      Object.assign(process.env, env);
      t.after(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      });
      let selected: ExecutionPolicy = executionPolicy('host');
      const session = store.create(root);
      const agent = await createAgent(
        store,
        root,
        {
          json: false,
          allowWrite: false,
          allowCommand: false,
          help: false,
          maxContextTokens: 128000,
          maxOutputTokens: 4096,
        },
        async () => true,
        () => undefined,
        () => {},
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => selected,
      );
      selected = executionPolicy(scenario.selected, {
        files: 'files' in scenario ? scenario.files : 'workspace-write',
      });
      const result = await agent.run({
        sessionId: session.id,
        prompt: 'Delegate once',
        signal: AbortSignal.timeout(20_000),
      });
      assert.equal(result.subagents?.length, 1, JSON.stringify(result));
      const child = result.subagents![0]!;
      if (scenario.allowed) {
        assert.equal(child.status, 'completed', child.error);
        assert.equal(children, 1);
        assert.equal(store.workspaceBindingsByState(['ready']).length, 1);
      } else {
        assert.equal(child.status, 'failed', JSON.stringify(child));
        assert.match(child.error ?? '', /WORKSPACE_POLICY_UNSUPPORTED/);
        assert.match(child.error ?? '', /workspace-write file access/);
        assert.equal(children, 0, 'a refused child must not reach the model');
        assert.equal(
          store.workspaceSnapshots().length,
          0,
          'policy rejection must precede metadata writes',
        );
      }
      assert.equal(selected.mode, scenario.selected);
    },
  );
}

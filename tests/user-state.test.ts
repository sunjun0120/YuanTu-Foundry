import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { credentialsPath } from '../packages/providers/credentials.ts';
import { defaultMcpOAuthDirectory } from '../packages/mcp/oauth.ts';
import { memoryPaths } from '../packages/knowledge/memory.ts';
import { defaultKnowledgePath } from '../packages/knowledge/store.ts';

const state = path.join(tmpdir(), 'yuantu-user-state-fixture');
function withEnvironment(values: NodeJS.ProcessEnv, body: () => void) {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    body();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('credentials use the shared state root while a specific path still wins', () => {
  assert.equal(credentialsPath({ YUANTU_STATE_DIR: state }), path.join(state, 'credentials.json'));
  assert.equal(
    credentialsPath({
      YUANTU_STATE_DIR: state,
      YUANTU_CREDENTIALS_FILE: path.join(state, 'explicit.json'),
    }),
    path.join(state, 'explicit.json'),
  );
});
test('MCP OAuth uses the shared state root while a specific directory still wins', () => {
  assert.equal(
    defaultMcpOAuthDirectory({ YUANTU_STATE_DIR: state }),
    path.join(state, 'mcp-oauth'),
  );
  assert.equal(
    defaultMcpOAuthDirectory({ YUANTU_STATE_DIR: state, YUANTU_MCP_OAUTH_DIR: state }),
    state,
  );
});
test('memory and knowledge default beneath the shared state root with explicit overrides preserved', () => {
  withEnvironment(
    { YUANTU_STATE_DIR: state, YUANTU_MEMORY_DIR: undefined, YUANTU_KNOWLEDGE_DB: undefined },
    () => {
      assert.equal(memoryPaths(state).global, path.join(state, 'memory.md'));
      assert.equal(defaultKnowledgePath(), path.join(state, 'knowledge.sqlite'));
      withEnvironment(
        {
          YUANTU_MEMORY_DIR: path.join(state, 'memory'),
          YUANTU_KNOWLEDGE_DB: path.join(state, 'explicit.sqlite'),
        },
        () => {
          assert.equal(memoryPaths(state).global, path.join(state, 'memory', 'memory.md'));
          assert.equal(defaultKnowledgePath(), path.join(state, 'explicit.sqlite'));
        },
      );
    },
  );
});
test('an omitted shared root keeps the original default and a relative root is refused', () => {
  assert.equal(credentialsPath({}), path.join(homedir(), '.yuantu', 'credentials.json'));
  assert.throws(
    () => credentialsPath({ YUANTU_STATE_DIR: 'relative-state' }),
    /YUANTU_STATE_DIR must be an absolute path/,
  );
  assert.throws(
    () => defaultMcpOAuthDirectory({ YUANTU_STATE_DIR: 'relative-state' }),
    /YUANTU_STATE_DIR must be an absolute path/,
  );
});

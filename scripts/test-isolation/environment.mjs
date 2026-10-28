import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inside, resolvedTarget } from './paths.mjs';

const bootstrap = pathToFileURL(fileURLToPath(new URL('./bootstrap.mjs', import.meta.url))).href;
export async function createIsolation(parentRoot, file, resources = [], baseEnv = process.env) {
  let ancestorProcessPaths = [];
  if (process.env.FOUNDRY_TEST_ISOLATION) {
    const owner = JSON.parse(process.env.FOUNDRY_TEST_ISOLATION);
    if (!inside(owner.root, resolvedTarget(parentRoot)))
      throw new Error('nested isolation root must belong to its owner');
    ancestorProcessPaths = [...(owner.ancestorProcessPaths ?? []), owner.processPath];
  }
  await mkdir(parentRoot, { recursive: true });
  const root = await realpath(
    await mkdtemp(path.join(parentRoot, `${path.basename(file).replace(/[^a-zA-Z0-9.-]/g, '-')}-`)),
  );
  const paths = Object.fromEntries(
    ['tmp', 'home', 'state', 'cache', 'artifacts'].map((name) => [name, path.join(root, name)]),
  );
  await Promise.all(Object.values(paths).map((directory) => mkdir(directory, { recursive: true })));
  const control = path.join(parentRoot, 'control');
  await mkdir(control, { recursive: true });
  const id = randomUUID();
  const violationPath = path.join(control, `${id}-violations.ndjson`);
  const processPath = path.join(control, `${id}-processes.ndjson`);
  const env = { ...baseEnv };
  for (const key of Object.keys(env))
    if (/^YUANTU_/.test(key) || /^(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE)_API_KEY$/.test(key))
      delete env[key];
  delete env.NODE_TEST_CONTEXT;
  // The snapshot regeneration flag is the one variable a worker must never inherit: tests/turn-snapshot reads it
  // and *records* instead of comparing, so an exported value would make the whole snapshot gate pass
  // unconditionally. `scripts/update-snapshots.mjs` re-adds it deliberately for the one run that wants it.
  delete env.FOUNDRY_TEST_GENERATE_SNAPSHOTS;
  delete env.UPDATE_SNAPSHOTS;
  // Collection destinations belong to controllers, never descendants or nested runners.
  delete env.FOUNDRY_TEST_COVERAGE_DIR;
  // A nested runner's failure semantics are the fixture's own business; only the outer gate decides to continue.
  delete env.FOUNDRY_TEST_CONTINUE_ON_FAILURE;
  if (env.NODE_V8_COVERAGE) {
    env.NODE_V8_COVERAGE = path.join(root, 'coverage');
    await mkdir(env.NODE_V8_COVERAGE, { recursive: true });
  }
  Object.assign(env, {
    TMP: paths.tmp,
    TEMP: paths.tmp,
    TMPDIR: paths.tmp,
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: path.join(paths.home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(paths.home, 'AppData', 'Local'),
    XDG_CACHE_HOME: paths.cache,
    XDG_CONFIG_HOME: paths.state,
    XDG_DATA_HOME: paths.state,
    XDG_RUNTIME_DIR: paths.tmp,
    NODE_COMPILE_CACHE: path.join(paths.cache, 'node'),
    npm_config_cache: path.join(paths.cache, 'npm'),
    // Portable fixtures must not accidentally select a machine-wide native backend.
    // Native acceptance fixtures select their backend explicitly at the operation boundary.
    YUANTU_SANDBOX: 'host',
    YUANTU_STATE_DIR: paths.state,
    // Tests must not read a user's analysis-service cache or contact the backend.
    YUANTU_BUILTIN_SERVICES: '0',
    // Temporary workspaces sit inside this repository, so a Host or CLI a test starts must not write to its
    // `.git/info/exclude`; the cases that exercise the exclusion enable it explicitly.
    YUANTU_GIT_EXCLUDE: '0',
    // Command text runs in cmd: a PowerShell start costs 0.4–1.2 s under the suite's eight-way load. The PowerShell
    // path has its own file (`tests/windows-shell.test.ts`), which switches this back to `auto`.
    YUANTU_TEST_WINDOWS_SHELL: 'cmd',
    FOUNDRY_TEST_ROOT: root,
    FOUNDRY_TEST_ARTIFACTS: paths.artifacts,
    // The desktop window deliberately does not read the process record; its smoke suites still assert that record,
    // so they opt the test process back in rather than making production pay for a panel it does not have.
    FOUNDRY_TEST_DESKTOP_AUDIT: '1',
    FOUNDRY_TEST_ISOLATION: JSON.stringify({
      root,
      file,
      resources,
      violationPath,
      processPath,
      ancestorProcessPaths,
      repository: process.cwd(),
    }),
    NODE_OPTIONS: `--import=${bootstrap}`,
  });
  await Promise.all(
    [env.APPDATA, env.LOCALAPPDATA, env.NODE_COMPILE_CACHE, env.npm_config_cache].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  return { root, file, resources, violationPath, processPath, env };
}

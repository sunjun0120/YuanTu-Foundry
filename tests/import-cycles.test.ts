import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tempRoot } from './temp-fixture.ts';

const gate = fileURLToPath(new URL('../scripts/check-import-cycles.mjs', import.meta.url));
const cases = [
  {
    name: 'Rust build artifacts cannot introduce source import cycles',
    code: 0,
    files: {
      'source.ts': 'export const source = 1;',
      'native/Cargo.toml': '[package]\nname = "fixture"\nversion = "0.1.0"\n',
      'native/target/a.ts': "import { b } from './b.ts';\nexport const a = b;",
      'native/target/b.ts': "import { a } from './a.ts';\nexport const b = a;",
    },
  },
  {
    name: 'a regular target source directory still participates in cycle checks',
    code: 1,
    files: {
      'target/a.ts': "import { b } from './b.ts';\nexport const a = b;",
      'target/b.ts': "import { a } from './a.ts';\nexport const b = a;",
    },
  },
  {
    name: 'leading whitespace cannot hide a static cycle',
    code: 1,
    files: {
      'a.ts': "  import { b } from './b.ts';\nexport const a = 1;",
      'b.ts': "import { a } from './a.ts';\nexport const b = 2;",
    },
  },
  {
    name: 'a BOM cannot hide a static cycle',
    code: 1,
    files: {
      'a.ts': "\uFEFFimport { b } from './b.ts';\nexport const a = 1;",
      'b.ts': "import { a } from './a.ts';\nexport const b = 2;",
    },
  },
  {
    name: 'imports written inside comments cannot create a cycle',
    code: 0,
    files: {
      'a.ts': "/*\nimport { b } from './b.ts';\n*/\nexport const a = 1;",
      'b.ts': "import { a } from './a.ts';\nexport const b = 2;",
    },
  },
  {
    name: 'type-only imports and re-exports cannot create a value cycle',
    code: 0,
    files: {
      'a.ts':
        "export type { B } from './b.ts';\nimport { type B as Alias } from './b.ts';\nexport const a = 1;",
      'b.ts': "import { a } from './a.ts';\nexport type B = typeof a;",
    },
  },
  {
    name: 'a value re-export participates in a cycle',
    code: 1,
    files: {
      'a.ts': "export * from './b.ts';\nexport const a = 1;",
      'b.ts': "import { a } from './a.ts';\nexport const b = a;",
    },
  },
  {
    name: 'an mts module participates in a cycle',
    code: 1,
    files: {
      'a.mts': "import { b } from './b.mts';\nexport const a = 1;",
      'b.mts': "import { a } from './a.mts';\nexport const b = 2;",
    },
  },
  {
    name: 'a component participates in a value cycle',
    code: 1,
    files: {
      'a.tsx': "import { b } from './b.tsx';\nexport const a = b;",
      'b.tsx': "import { a } from './a.tsx';\nexport const b = () => a;",
    },
  },
  {
    name: 'CommonJS import-equals participates in a static cycle',
    code: 1,
    files: {
      'a.cts': "import b = require('./b.cts');\nexport const a = 1;",
      'b.cts': "import a = require('./a.cts');\nexport const b = 2;",
    },
  },
];

for (const item of cases) {
  test(item.name, async (t) => {
    const root = await tempRoot(t, 'yuantu-cycle-gate-');
    const sources = path.join(root, 'packages', 'fixture');
    await mkdir(sources, { recursive: true });
    for (const [name, body] of Object.entries(item.files)) {
      await mkdir(path.dirname(path.join(sources, name)), { recursive: true });
      await writeFile(path.join(sources, name), body);
    }
    const result = spawnSync(process.execPath, [gate], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, item.code, result.stdout + result.stderr);
    if (item.code) assert.match(result.stderr, /value-import cycle/);
    else assert.match(result.stdout, /0 cycles/);
  });
}

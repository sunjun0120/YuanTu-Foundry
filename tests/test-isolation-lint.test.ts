import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectIsolation, lintTestIsolation } from '../scripts/test-isolation-lint.ts';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('isolation lint catches cwd changes including imported and assigned aliases', () => {
  for (const code of [
    'process.chdir(root);',
    'const move = process.chdir; move(root);',
    'const { chdir: move } = process; move(root);',
    "import { chdir as move } from 'node:process'; move(root);",
    'const p = process; const q=p; const {chdir: move}=q; move(root);',
    "const move=process['chdir']; move(root);",
    'const move=process.chdir.bind(process); move(root);',
  ])
    assert.ok(inspectIsolation(code, 'fixture.ts').some((issue) => issue.rule === 'cwd'));
});
test('isolation lint catches real static port bindings without confusing function binding or fixture input', () => {
  for (const code of [
    "import {createServer} from 'node:http'; createServer().listen(3210);",
    "import net from 'node:net'; const server=net.createServer(); server.listen({port:3210});",
    "import {createSocket} from 'node:dgram'; const s=createSocket('udp4'); s.bind(3210);",
    "import * as http from 'node:http'; const make=http.createServer; const s=make(); const options={port:3210}; s.listen(options);",
    "import {Server} from 'node:net'; const s=new Server(); const port=3210; s.listen(port);",
  ])
    assert.ok(inspectIsolation(code, 'fixture.ts').some((issue) => issue.rule === 'port'));
  assert.deepEqual(
    inspectIsolation("const f = fn.bind(3210); const url='http://127.0.0.1:1';", 'fixture.ts'),
    [],
  );
  assert.deepEqual(
    inspectIsolation(
      "import{createServer}from'node:http';createServer().listen(0,'127.0.0.1');",
      'fixture.ts',
    ),
    [],
  );
});

test('filesystem aliases and user-global writes are detected without banning path assertions', () => {
  for (const code of [
    "import fs from 'node:fs'; const {writeFileSync: write}=fs; write('artifacts/out','x');",
    "import fs from 'node:fs'; const f=fs.promises; const write=f.writeFile; write('out','x');",
    "const {mkdirSync: make}=require('node:fs'); make('.scratch');",
    "import {writeFile} from 'node:fs/promises'; import {homedir} from 'node:os'; import {join} from 'node:path'; writeFile(join(homedir(),'.yuantu','state'),'x');",
  ])
    assert.ok(
      inspectIsolation(code, 'fixture.ts').some((issue) => ['write', 'state'].includes(issue.rule)),
      code,
    );
  assert.deepEqual(
    inspectIsolation(
      "import {homedir} from 'node:os'; assert.equal(actual,path.join(homedir(),'.yuantu'));",
      'fixture.ts',
    ),
    [],
  );
});

test('requested entries include local test helpers transitively', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-lint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'tests'));
  await writeFile(path.join(root, 'tests/one.test.ts'), "import './helper.ts';");
  await writeFile(path.join(root, 'tests/helper.ts'), "export * from './nested.ts';");
  await writeFile(path.join(root, 'tests/nested.ts'), 'process.chdir(root);');
  const issues = await lintTestIsolation(root, ['tests/one.test.ts']);
  assert.deepEqual(
    issues.map(({ file, rule }) => ({ file, rule })),
    [{ file: 'tests/nested.ts', rule: 'cwd' }],
  );
});
test('isolation lint catches literal repository write outputs while allowing private fixture paths', () => {
  assert.ok(
    inspectIsolation(
      "import {mkdir} from 'node:fs/promises'; await mkdir('artifacts/screens');",
      'fixture.ts',
    ).some((issue) => issue.rule === 'write'),
  );
  assert.deepEqual(
    inspectIsolation(
      "import{writeFile}from'node:fs/promises';await writeFile(path.join(root,'out.txt'),'body');",
      'fixture.ts',
    ),
    [],
  );
});

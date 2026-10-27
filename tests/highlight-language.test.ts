import test from 'node:test';
import assert from 'node:assert/strict';
import { languageForPath } from '../apps/desktop/highlight.ts';

test('the code preview maps the required extensions and leaves unknown text plain', () => {
  const cases: [string, string | null][] = [
    ['app.js', 'javascript'],
    ['app.jsx', 'javascript'],
    ['app.mjs', 'javascript'],
    ['app.ts', 'typescript'],
    ['app.tsx', 'typescript'],
    ['package.json', 'json'],
    ['script.py', 'python'],
    ['index.html', 'xml'],
    ['layout.xml', 'xml'],
    ['style.css', 'css'],
    ['run.sh', 'bash'],
    ['run.ps1', 'powershell'],
    ['config.yml', 'yaml'],
    ['Main.java', 'java'],
    ['main.go', 'go'],
    ['main.rs', 'rust'],
    ['main.c', 'c'],
    ['main.h', 'c'],
    ['main.cpp', 'cpp'],
    ['main.hpp', 'cpp'],
    ['query.sql', 'sql'],
    ['notes.txt', null],
    ['Dockerfile', null],
    ['.gitignore', null],
    ['README', null],
  ];
  for (const [path, language] of cases) assert.equal(languageForPath(path), language, path);
  assert.equal(languageForPath('C:\\repo\\main.rs'), 'rust');
  assert.equal(languageForPath('UPPER.TS'), 'typescript');
});

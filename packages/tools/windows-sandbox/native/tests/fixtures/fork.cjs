const r = require('node:child_process').spawnSync(
  process.execPath,
  ['-e', "process.stdout.write(require('fs').readFileSync(0,'utf8'))"],
  { input: 'ping', encoding: 'utf8' },
);
if (r.error) {
  console.log('FORK-FAIL', r.error.code);
  process.exit(3);
}
console.log(r.stdout === 'ping' ? 'FORK-OK' : 'FORK-BAD');

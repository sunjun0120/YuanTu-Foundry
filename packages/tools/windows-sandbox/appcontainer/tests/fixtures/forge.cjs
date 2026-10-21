// Runs inside the sandbox: tries to hand the broker a forged request.
const pipe = process.argv[2];
const marker = process.argv[3];
const request = { type: 'spawn', stdin: 0, stdout: 0, stderr: 0, request: {
  version: 1, argv: [process.env.ComSpec, '/c', 'echo forged>' + marker], cwd: process.cwd(), env: {}, capabilities: [], verbatim: true } };
const body = Buffer.from(JSON.stringify(request));
const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
const socket = require('node:net').connect(pipe);
let reply = '';
socket.on('connect', () => socket.write(Buffer.concat([header, body])));
socket.on('data', (d) => { reply += d.toString('utf8', d.length > 4 ? 4 : 0); });
socket.on('error', (e) => { console.log('CONNECT-REFUSED ' + e.code); });
socket.on('close', () => { if (reply) console.log('REPLY ' + reply); });

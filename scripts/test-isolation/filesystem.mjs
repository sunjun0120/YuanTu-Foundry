import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function installFilesystemProbe(checkWrite, violate) {
  const original = Object.fromEntries(Object.keys(fs).map((key) => [key, fs[key]]));
  const descriptors = new Map();
  const writing = (flags) =>
    typeof flags === 'number'
      ? !!(
          flags &
          (fs.constants.O_WRONLY |
            fs.constants.O_RDWR |
            fs.constants.O_CREAT |
            fs.constants.O_TRUNC |
            fs.constants.O_APPEND)
        )
      : /[wa+]/.test(flags ?? 'r');
  const fd = (value) => {
    if (value >= 0 && value <= 2) return;
    const owner = descriptors.get(value);
    if (owner === undefined) violate('ownership', `unknown writable file descriptor ${value}`);
    checkWrite(owner);
  };
  const target = (value) => (typeof value === 'number' ? fd(value) : checkWrite(value));
  for (const name of [
    'writeFile',
    'appendFile',
    'truncate',
    'chmod',
    'chown',
    'utimes',
    'lutimes',
    'lchmod',
    'lchown',
    'rm',
    'rmdir',
    'unlink',
    'mkdir',
    'mkdtemp',
  ]) {
    for (const method of [name, name + 'Sync'])
      if (typeof fs[method] === 'function')
        fs[method] = function (file, ...args) {
          target(file);
          return Reflect.apply(original[method], this, [file, ...args]);
        };
    if (typeof fs.promises[name] === 'function') {
      const method = fs.promises[name];
      fs.promises[name] = async function (file, ...args) {
        target(file);
        return Reflect.apply(method, this, [file, ...args]);
      };
    }
  }
  for (const name of ['rename', 'link', 'copyFile', 'cp', 'symlink']) {
    const check = (from, to) => {
      if (name === 'rename' || name === 'link') checkWrite(from);
      if (name === 'symlink') {
        const destination = to instanceof URL ? fileURLToPath(to) : String(to);
        checkWrite(path.resolve(path.dirname(destination), String(from)));
      }
      checkWrite(to);
    };
    for (const method of [name, name + 'Sync'])
      if (typeof fs[method] === 'function')
        fs[method] = function (from, to, ...args) {
          check(from, to);
          return Reflect.apply(original[method], this, [from, to, ...args]);
        };
    if (typeof fs.promises[name] === 'function') {
      const method = fs.promises[name];
      fs.promises[name] = async function (from, to, ...args) {
        check(from, to);
        return Reflect.apply(method, this, [from, to, ...args]);
      };
    }
  }
  fs.openSync = function (file, flags, ...args) {
    if (writing(flags)) checkWrite(file);
    const descriptor = original.openSync.call(this, file, flags, ...args);
    descriptors.set(descriptor, file);
    return descriptor;
  };
  fs.open = function (file, flags, ...args) {
    if (writing(flags)) checkWrite(file);
    const callback = args.pop();
    return original.open.call(this, file, flags, ...args, (error, descriptor) => {
      if (!error) descriptors.set(descriptor, file);
      callback(error, descriptor);
    });
  };
  const open = fs.promises.open;
  fs.promises.open = async function (file, flags, ...args) {
    if (writing(flags)) checkWrite(file);
    const handle = await open.call(this, file, flags, ...args);
    descriptors.set(handle.fd, file);
    for (const name of [
      'write',
      'writev',
      'writeFile',
      'appendFile',
      'truncate',
      'chmod',
      'chown',
      'utimes',
      'createWriteStream',
    ]) {
      const method = handle[name];
      if (typeof method === 'function')
        handle[name] = function (...values) {
          checkWrite(file);
          return Reflect.apply(method, this, values);
        };
    }
    return handle;
  };
  for (const name of [
    'write',
    'writeSync',
    'writev',
    'writevSync',
    'ftruncate',
    'ftruncateSync',
    'fchmod',
    'fchmodSync',
    'fchown',
    'fchownSync',
    'futimes',
    'futimesSync',
  ]) {
    fs[name] = function (descriptor, ...args) {
      fd(descriptor);
      return Reflect.apply(original[name], this, [descriptor, ...args]);
    };
  }
  fs.createWriteStream = function (file, options) {
    if (options?.fd !== undefined && options.fd !== null)
      fd(typeof options.fd === 'number' ? options.fd : options.fd.fd);
    else checkWrite(file);
    return original.createWriteStream.call(this, file, options);
  };
  // Preserve Node's promisify result metadata (for example write -> {bytesWritten, buffer}).
  for (const [name, method] of Object.entries(original)) {
    if (typeof method !== 'function' || method === fs[name]) continue;
    for (const symbol of Object.getOwnPropertySymbols(method))
      Object.defineProperty(fs[name], symbol, Object.getOwnPropertyDescriptor(method, symbol));
  }
}

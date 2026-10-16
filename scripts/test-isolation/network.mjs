import net from 'node:net';
import dgram from 'node:dgram';
export function installNetworkProbe(checkWrite, violate) {
  function validate(args) {
    let [port, host] = args;
    if (port && typeof port === 'object') {
      if (port.path) {
        checkWrite(port.path);
        return;
      }
      host = port.host ?? port.address;
      port = port.port;
    }
    if (typeof port === 'string' && !/^\d+$/.test(port)) {
      checkWrite(port);
      return;
    }
    if (port !== 0 || !['127.0.0.1', '::1', 'localhost'].includes(host))
      violate('port', 'listeners must use loopback port 0');
  }
  for (const [prototype, method] of [
    [net.Server.prototype, 'listen'],
    [dgram.Socket.prototype, 'bind'],
  ]) {
    const original = prototype[method];
    prototype[method] = function (...args) {
      validate(args);
      return Reflect.apply(original, this, args);
    };
  }
}

import { createRequire } from 'node:module';
const sqlite = createRequire(import.meta.url)('node:sqlite');

export function installSQLiteProbe(checkWrite, violate) {
  const Original = sqlite.DatabaseSync;
  const backup = sqlite.backup;
  sqlite.backup = function (database, destination, ...args) {
    checkWrite(destination);
    return Reflect.apply(backup, this, [database, destination, ...args]);
  };
  function checkSQL(sql, values = []) {
    // Guard file-producing statements separately: SQLite bypasses the public node:fs entry points.
    const stripped = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
    const pattern =
      /(?:^|;)\s*(?:VACUUM\b[^;]*?\bINTO|ATTACH(?:\s+DATABASE)?|PRAGMA\s+(?:temp_store_directory|data_store_directory)\s*=)\s*([^;]*)/gi;
    for (const match of stripped.matchAll(pattern)) {
      const operand = /^(\?\d*|[:@$]\w+|'(?:''|[^'])*'|"(?:""|[^"])*")\s*(.*)$/s.exec(match[1]);
      if (!operand || (operand[2] && !/^AS\s+/i.test(operand[2])))
        violate('sqlite', 'file-producing SQL requires a direct owned filename, not an expression');
      const value = operand[1];
      let file;
      if (value.startsWith("'") || value.startsWith('"'))
        file = value.slice(1, -1).replaceAll(value[0].repeat(2), value[0]);
      else if (value.startsWith('?')) file = values[Number(value.slice(1) || 1) - 1];
      else file = values[0]?.[value] ?? values[0]?.[value.slice(1)];
      if (file !== ':memory:') {
        if (typeof file !== 'string')
          violate('sqlite', 'file-producing SQL requires an owned filename');
        checkWrite(file);
      }
    }
  }
  sqlite.DatabaseSync = class IsolatedDatabaseSync extends Original {
    constructor(...args) {
      const [file, options] = args;
      if (file !== ':memory:' && options?.open !== false && !options?.readOnly) checkWrite(file);
      super(...args);
      this.isolationFile = file;
      this.isolationReadOnly = options?.readOnly;
    }
    open() {
      if (this.isolationFile !== ':memory:' && !this.isolationReadOnly)
        checkWrite(this.isolationFile);
      return super.open();
    }
    exec(sql) {
      checkSQL(sql);
      return super.exec(sql);
    }
    prepare(sql) {
      const statement = super.prepare(sql);
      for (const name of ['run', 'get', 'all', 'iterate']) {
        const method = statement[name];
        statement[name] = function (...values) {
          checkSQL(sql, values);
          return Reflect.apply(method, this, values);
        };
      }
      return statement;
    }
  };
}

import { createRequire } from 'node:module';
const sqlite = createRequire(import.meta.url)('node:sqlite');

// Comments and statement boundaries only have meaning outside quoted SQL tokens.
function statements(sql) {
  const result = [];
  let tokens = [],
    word = '';
  const flush = () => {
    if (word) tokens.push(word);
    word = '';
  };
  for (let index = 0; index < sql.length;) {
    const character = sql[index];
    if (/\s/.test(character)) {
      flush();
      index++;
    } else if (sql.startsWith('--', index)) {
      flush();
      const end = sql.indexOf('\n', index + 2);
      index = end < 0 ? sql.length : end + 1;
    } else if (sql.startsWith('/*', index)) {
      flush();
      const end = sql.indexOf('*/', index + 2);
      index = end < 0 ? sql.length : end + 2;
    } else if (["'", '"', '`', '['].includes(character)) {
      flush();
      const start = index++,
        close = character === '[' ? ']' : character;
      while (index < sql.length) {
        if (sql[index++] !== close) continue;
        if (sql[index] === close) {
          index++;
          continue;
        }
        break;
      }
      tokens.push(sql.slice(start, index));
    } else if (';=(),.'.includes(character)) {
      flush();
      index++;
      if (character === ';') {
        result.push(tokens);
        tokens = [];
      } else tokens.push(character);
    } else {
      word += character;
      index++;
    }
  }
  flush();
  if (tokens.length) result.push(tokens);
  return result;
}

/** A pragma name as written, with its quoting removed: `"temp_store_directory"` names the same pragma. */
function pragmaName(token) {
  if (typeof token !== 'string') return '';
  if (/^(['"`]).*\1$/.test(token))
    return token
      .slice(1, -1)
      .replaceAll(token[0] + token[0], token[0])
      .toUpperCase();
  if (/^\[.*\]$/.test(token)) return token.slice(1, -1).toUpperCase();
  return token.toUpperCase();
}

export function installSQLiteProbe(checkWrite, violate) {
  const Original = sqlite.DatabaseSync;
  const backup = sqlite.backup;
  sqlite.backup = function (database, destination, ...args) {
    checkWrite(destination);
    return Reflect.apply(backup, this, [database, destination, ...args]);
  };
  function checkSQL(sql, values = []) {
    // Guard file-producing statements separately: SQLite bypasses the public node:fs entry points.
    for (const tokens of statements(sql)) {
      const keyword = tokens[0]?.toUpperCase();
      let index;
      let parenthesized = false;
      if (keyword === 'VACUUM') {
        const into = tokens.findIndex((token) => token.toUpperCase() === 'INTO');
        if (into < 0) continue;
        index = into + 1;
      } else if (keyword === 'ATTACH') index = tokens[1]?.toUpperCase() === 'DATABASE' ? 2 : 1;
      else if (keyword === 'PRAGMA') {
        const name = tokens[2] === '.' ? 3 : 1;
        if (!['TEMP_STORE_DIRECTORY', 'DATA_STORE_DIRECTORY'].includes(pragmaName(tokens[name])))
          continue;
        // Two spellings set the same directory: `PRAGMA name = 'path'` and SQLite's function-call form
        // `PRAGMA name('path')`. Reading only the first let the second point SQLite at a directory outside the
        // worker's ownership with no violation recorded; a quoted pragma name was skipped for the same reason.
        if (tokens[name + 1] === '=') index = name + 2;
        else if (tokens[name + 1] === '(' && tokens[name + 3] === ')') {
          index = name + 2;
          parenthesized = true;
        } else continue; // The bare query form reads the directory, and sets nothing.
      } else continue;
      const value = tokens[index];
      const rest = tokens.slice(index + 1);
      if (parenthesized && rest.length === 1 && rest[0] === ')') rest.pop();
      if (
        !value ||
        !/^(?:\?\d*|[:@$]\w+|'(?:''|[^'])*'|"(?:""|[^"])*")$/.test(value) ||
        (keyword === 'ATTACH'
          ? rest.length !== 2 || rest[0].toUpperCase() !== 'AS'
          : rest.length !== 0)
      )
        violate('sqlite', 'file-producing SQL requires a direct owned filename, not an expression');
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

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

export interface IsolationIssue {
  file: string;
  line: number;
  rule: string;
  message: string;
}
const writers = new Set([
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'mkdir',
  'mkdirSync',
  'rm',
  'rmSync',
  'unlink',
  'unlinkSync',
  'rename',
  'renameSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'symlink',
  'symlinkSync',
  'link',
  'linkSync',
  'truncate',
  'truncateSync',
  'createWriteStream',
]);

/** Catch obvious violations statically; dynamic paths are checked by the worker's runtime probes. */
export function inspectIsolation(source: string, file: string): IsolationIssue[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports = new Map<string, { module: string; name: string }>();
  const variables = new Map<string, ts.Expression>();
  const issues: IsolationIssue[] = [];
  const collect = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = node.moduleSpecifier.text.replace(/^node:/, '');
      const clause = node.importClause;
      if (clause?.name) imports.set(clause.name.text, { module, name: '*' });
      const named = clause?.namedBindings;
      if (named && ts.isNamespaceImport(named)) imports.set(named.name.text, { module, name: '*' });
      else if (named)
        for (const entry of named.elements)
          imports.set(entry.name.text, {
            module,
            name: entry.propertyName?.text ?? entry.name.text,
          });
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) variables.set(node.name.text, node.initializer);
      else if (ts.isObjectBindingPattern(node.name))
        for (const element of node.name.elements)
          if (ts.isIdentifier(element.name))
            variables.set(
              element.name.text,
              ts.factory.createPropertyAccessExpression(
                node.initializer,
                element.propertyName?.getText(ast) ?? element.name.text,
              ),
            );
    }
    ts.forEachChild(node, collect);
  };
  collect(ast);
  const valueOf = (expr: ts.Identifier): ts.Expression | undefined => {
    for (let scope: ts.Node | undefined = expr.parent; scope; scope = scope.parent) {
      if (
        ts.isFunctionLike(scope) &&
        scope.parameters.some((parameter) => parameter.name.getText(ast) === expr.text)
      )
        return undefined;
      if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
        for (const statement of scope.statements) {
          if (!ts.isVariableStatement(statement)) continue;
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.name.text === expr.text)
              return declaration.initializer;
            if (ts.isObjectBindingPattern(declaration.name)) {
              for (const binding of declaration.name.elements)
                if (
                  ts.isIdentifier(binding.name) &&
                  binding.name.text === expr.text &&
                  declaration.initializer
                )
                  return ts.factory.createPropertyAccessExpression(
                    declaration.initializer,
                    binding.propertyName?.getText(ast) ?? binding.name.text,
                  );
            }
          }
        }
      }
    }
    return undefined;
  };
  const member = (expr: ts.Expression, depth = 0): { module: string; name: string } | undefined => {
    if (depth > 12) return undefined;
    if (ts.isIdentifier(expr))
      return (
        imports.get(expr.text) ??
        (expr.text === 'process'
          ? { module: 'process', name: '*' }
          : valueOf(expr)
            ? member(valueOf(expr)!, depth + 1)
            : undefined)
      );
    if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
      const base = member(expr.expression, depth + 1);
      const name = ts.isPropertyAccessExpression(expr)
        ? expr.name.text
        : expr.argumentExpression && ts.isStringLiteralLike(expr.argumentExpression)
          ? expr.argumentExpression.text
          : undefined;
      if (base?.module === 'fs' && name === 'promises') return { module: 'fs/promises', name: '*' };
      if (base?.name === '*' && name) return { module: base.module, name };
    }
    if (
      ts.isCallExpression(expr) &&
      ts.isPropertyAccessExpression(expr.expression) &&
      expr.expression.name.text === 'bind'
    )
      return member(expr.expression.expression, depth + 1);
    if (
      ts.isCallExpression(expr) &&
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === 'require' &&
      expr.arguments[0] &&
      ts.isStringLiteralLike(expr.arguments[0])
    )
      return { module: expr.arguments[0].text.replace(/^node:/, ''), name: '*' };
    return undefined;
  };
  const server = (expr: ts.Expression, depth = 0): boolean => {
    if (depth > 4) return false;
    if (ts.isIdentifier(expr)) {
      const value = valueOf(expr);
      return !!value && server(value, depth + 1);
    }
    if (!ts.isCallExpression(expr) && !ts.isNewExpression(expr)) return false;
    const origin = member(expr.expression);
    return (
      !!origin &&
      ['http', 'https', 'http2', 'net', 'tls', 'dgram'].includes(origin.module) &&
      ['createServer', 'createSecureServer', 'createSocket', 'Server', 'Socket'].includes(
        origin.name,
      )
    );
  };
  const baseLiteral = (expr: ts.Expression | undefined, depth = 0): string | undefined => {
    if (!expr || depth > 5) return undefined;
    if (ts.isStringLiteralLike(expr)) return expr.text || undefined;
    if (
      ts.isCallExpression(expr) &&
      member(expr.expression)?.module === 'os' &&
      member(expr.expression)?.name === 'homedir'
    )
      return '<user-home>';
    if (
      ts.isPropertyAccessExpression(expr) &&
      ts.isPropertyAccessExpression(expr.expression) &&
      expr.expression.expression.getText(ast) === 'process' &&
      expr.expression.name.text === 'env' &&
      ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'].includes(expr.name.text)
    )
      return '<user-home>';
    if (ts.isIdentifier(expr)) {
      for (let scope: ts.Node | undefined = expr.parent; scope; scope = scope.parent) {
        if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
          for (const statement of scope.statements)
            if (ts.isVariableStatement(statement)) {
              for (const declaration of statement.declarationList.declarations)
                if (ts.isIdentifier(declaration.name) && declaration.name.text === expr.text)
                  return statement.declarationList.flags & ts.NodeFlags.Const
                    ? baseLiteral(declaration.initializer, depth + 1)
                    : undefined;
            }
        }
        if (
          ts.isFunctionLike(scope) &&
          scope.parameters.some((parameter) => parameter.name.getText(ast) === expr.text)
        )
          return undefined;
      }
      return undefined;
    }
    if (
      ts.isCallExpression(expr) &&
      ['join', 'resolve'].includes(
        member(expr.expression)?.name ??
          (ts.isPropertyAccessExpression(expr.expression) ? expr.expression.name.text : ''),
      )
    )
      return baseLiteral(expr.arguments[0], depth + 1);
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return baseLiteral(expr.left, depth + 1);
    if (ts.isTemplateExpression(expr) && expr.head.text) return expr.head.text;
    return undefined;
  };
  const add = (node: ts.Node, rule: string, message: string) =>
    issues.push({
      file,
      line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
      rule,
      message,
    });
  const booleanOnly = (expression: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(expression)) return booleanOnly(expression.expression);
    if ([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(expression.kind))
      return true;
    if (ts.isPrefixUnaryExpression(expression))
      return expression.operator === ts.SyntaxKind.ExclamationToken;
    if (ts.isConditionalExpression(expression))
      return booleanOnly(expression.whenTrue) && booleanOnly(expression.whenFalse);
    if (ts.isBinaryExpression(expression)) {
      if (
        [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(
          expression.operatorToken.kind,
        )
      )
        return booleanOnly(expression.left) && booleanOnly(expression.right);
      return [
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.LessThanToken,
        ts.SyntaxKind.LessThanEqualsToken,
        ts.SyntaxKind.GreaterThanToken,
        ts.SyntaxKind.GreaterThanEqualsToken,
        ts.SyntaxKind.InKeyword,
        ts.SyntaxKind.InstanceOfKeyword,
      ].includes(expression.operatorToken.kind);
    }
    return (
      ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'Boolean'
    );
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) &&
      node.name.text === 'skip' &&
      node.initializer.kind !== ts.SyntaxKind.FalseKeyword &&
      booleanOnly(node.initializer)
    )
      add(
        node,
        'skip-reason',
        'A conditional skip must explain why: use condition && reason or condition ? reason : false',
      );
    if (ts.isCallExpression(node)) {
      const origin = member(node.expression);
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ['test', 'it', 'describe'].includes(node.expression.expression.getText(ast)) &&
        node.expression.name.text === 'skip'
      )
        add(
          node,
          'skip-reason',
          'Use test(..., { skip: reason }, ...) instead of test.skip/it.skip/describe.skip',
        );
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(ast) === 't' &&
        node.expression.name.text === 'skip' &&
        node.arguments.length === 0
      )
        add(node, 'skip-reason', 'A t.skip call must include a reason');
      if (origin?.module === 'process' && origin.name === 'chdir')
        add(node, 'cwd', 'Use a child process with an explicit cwd; process.chdir is prohibited');
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ['listen', 'bind'].includes(node.expression.name.text) &&
        server(node.expression.expression)
      ) {
        let argument = node.arguments[0];
        if (argument && ts.isIdentifier(argument)) argument = valueOf(argument) ?? argument;
        if (argument && ts.isObjectLiteralExpression(argument)) {
          const port = argument.properties.find(
            (item) => ts.isPropertyAssignment(item) && item.name.getText(ast) === 'port',
          );
          argument = port && ts.isPropertyAssignment(port) ? port.initializer : undefined;
        }
        if (argument && ts.isIdentifier(argument)) argument = valueOf(argument) ?? argument;
        if (
          argument &&
          ((ts.isNumericLiteral(argument) && Number(argument.text) !== 0) ||
            (ts.isStringLiteralLike(argument) &&
              /^\d+$/.test(argument.text) &&
              Number(argument.text) !== 0))
        )
          add(node, 'port', 'Bind loopback port 0 and read the assigned port');
      }
      if (origin && ['fs', 'fs/promises'].includes(origin.module) && writers.has(origin.name)) {
        const indices = /^(copyFile|cp)/.test(origin.name)
          ? [1]
          : /^(rename|link|symlink)/.test(origin.name)
            ? [0, 1]
            : [0];
        for (const index of indices) {
          const value = baseLiteral(node.arguments[index]);
          if (value !== undefined)
            add(
              node,
              value === '<user-home>' ? 'state' : 'write',
              'Write beneath the worker temporary root, not a fixed or repository-relative path',
            );
        }
      }
      if (
        origin &&
        ['fs', 'fs/promises'].includes(origin.module) &&
        ['open', 'openSync'].includes(origin.name)
      ) {
        const flags = node.arguments[1];
        const value = baseLiteral(node.arguments[0]);
        if (
          value !== undefined &&
          flags &&
          ts.isStringLiteralLike(flags) &&
          /[wa+]/.test(flags.text)
        )
          add(
            node,
            value === '<user-home>' ? 'state' : 'write',
            'Open writable files beneath the worker temporary root',
          );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return issues;
}

export async function lintTestIsolation(root: string, files?: string[]): Promise<IsolationIssue[]> {
  const result: IsolationIssue[] = [];
  async function walk(directory: string) {
    for (const item of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${item.name}`;
      if (item.isDirectory()) await walk(file);
      else if (/\.[cm]?[jt]s$/.test(item.name))
        result.push(...inspectIsolation(await readFile(path.join(root, file), 'utf8'), file));
    }
  }
  if (files) {
    const seen = new Set<string>();
    const inspect = async (file: string): Promise<void> => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = await readFile(path.resolve(root, file), 'utf8');
      result.push(...inspectIsolation(source, file));
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      for (const statement of ast.statements) {
        if (
          (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
          statement.moduleSpecifier &&
          ts.isStringLiteralLike(statement.moduleSpecifier) &&
          statement.moduleSpecifier.text.startsWith('.')
        ) {
          const target = path.resolve(root, path.dirname(file), statement.moduleSpecifier.text);
          if (
            target.startsWith(path.resolve(root, 'tests') + path.sep) &&
            /\.[cm]?[jt]s$/.test(target)
          )
            await inspect(path.relative(root, target).replaceAll('\\', '/'));
        }
      }
    };
    for (const file of files) await inspect(file);
  } else await walk('tests');
  return result;
}

import { randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import type { ToolCall, ToolSpec } from '../protocol/index.ts';

const MARKER = '<｜｜DSML｜｜';
const OPEN = `${MARKER} calls>`;
const CLOSE = '</｜｜DSML｜｜ calls>';
const PARAMETER_END = '</｜｜DSML｜｜ parameter>';
const schemas = new Ajv({ strict: true, allErrors: true, addUsedSchema: false });

/** Keep ordinary text streaming, holding only a possible DSML suffix until its meaning is known. */
export class DsmlContentBuffer {
  private pending = '';
  private held = false;

  push(part: string): string {
    this.pending += part;
    if (this.held) return '';
    const marker = this.pending.indexOf(MARKER);
    if (marker >= 0) {
      const text = this.pending.slice(0, marker);
      this.pending = this.pending.slice(marker);
      this.held = true;
      return text;
    }
    let retained = Math.min(this.pending.length, MARKER.length - 1);
    while (retained > 0 && !MARKER.startsWith(this.pending.slice(-retained))) retained--;
    const text = this.pending.slice(0, this.pending.length - retained);
    this.pending = this.pending.slice(this.pending.length - retained);
    return text;
  }

  flush(): string {
    const text = this.pending;
    this.pending = '';
    return text;
  }
}

/**
 * Only the observed terminal, unquoted block is a protocol candidate. Fences, inline examples and
 * blockquotes stay text. Do not search further through an example for a later executable-looking block.
 */
export function dsmlStart(text: string): number | undefined {
  const start = text.indexOf(MARKER);
  if (start < 0) return;
  const prefix = text.slice(0, start);
  if (prefix && !/\n[\t ]*\n$/.test(prefix)) return;
  if (/^ {0,3}(?:`{3,}|~{3,})/m.test(prefix)) return;
  return start;
}

/** Parse and validate the entire batch before exposing any calls to the normal tool pipeline. */
export function parseDsml(
  text: string,
  tools: readonly ToolSpec[],
): { text: string; toolCalls: ToolCall[] } | undefined {
  const start = dsmlStart(text);
  if (start === undefined) return;
  const fail = (reason: string): never => {
    throw new Error(`Invalid DSML tool calls: ${reason}`);
  };
  const block = text.slice(start).trimEnd();
  if (!block.startsWith(OPEN) || !block.endsWith(CLOSE)) fail('incomplete calls block');
  const body = block.slice(OPEN.length, -CLOSE.length);
  const calls: ToolCall[] = [];
  let cursor = 0;
  const whitespace = () => {
    while (cursor < body.length && /\s/.test(body[cursor]!)) cursor++;
  };
  const consume = (pattern: RegExp): RegExpExecArray => {
    pattern.lastIndex = cursor;
    const match = pattern.exec(body);
    if (!match) fail('unexpected tag or attributes');
    cursor = pattern.lastIndex;
    return match!;
  };
  whitespace();
  while (cursor < body.length) {
    if (calls.length >= 128) fail('too many calls');
    const invoke = consume(/<｜｜DSML｜｜ invoke name="([\w.:-]+)">/y);
    const name = invoke[1]!;
    const spec = tools.find((tool) => tool.name === name);
    if (!spec) fail('tool is not declared in this request');
    const args: Record<string, unknown> = {};
    whitespace();
    while (!body.startsWith('</｜｜DSML｜｜ invoke>', cursor)) {
      const parameter = consume(/<｜｜DSML｜｜ parameter name="([\w-]+)" string="(true|false)">/y);
      const key = parameter[1]!;
      if (Object.hasOwn(args, key) || ['__proto__', 'constructor', 'prototype'].includes(key))
        fail('duplicate or unsafe parameter');
      const end = body.indexOf(PARAMETER_END, cursor);
      if (end < 0) fail('incomplete parameter');
      const value = body.slice(cursor, end);
      if (value.includes(MARKER) || value.includes('</｜｜DSML｜｜')) fail('nested DSML tags');
      try {
        args[key] = parameter[2] === 'true' ? value : JSON.parse(value);
      } catch {
        fail('invalid JSON parameter');
      }
      cursor = end + PARAMETER_END.length;
      whitespace();
    }
    consume(/<\/｜｜DSML｜｜ invoke>/y);
    // No coercion, defaults, property removal or execution: the registry still applies its own checks.
    const validate = schemas.compile(spec!.inputSchema);
    if (!validate(args)) fail('arguments do not match the declared schema');
    calls.push({ id: `dsml_${randomUUID()}`, name, arguments: args });
    whitespace();
  }
  if (!calls.length) fail('empty calls block');
  return { text: text.slice(0, start), toolCalls: calls };
}

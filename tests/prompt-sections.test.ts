/**
 * The system prompt as named, ordered sections.
 *
 * The prompt used to be one `+`-joined expression inside the run loop, and three questions had no answer from
 * inside it: where a new fragment belongs, which fragment wrote a given paragraph, and what a child's persona
 * does to its parent's. This suite pins the four rules that replace those questions — order is total, empty
 * sections vanish, a section may replace another and say so, and the trace tells the truth about all three.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROMPT_STAGE_ORDER,
  assemblePrompt,
  definePromptSection,
  type PromptSection,
} from '../packages/core/prompt-sections.ts';

const part = (
  name: string,
  stage: PromptSection['stage'],
  order: number,
  content: string | undefined,
  replaces?: readonly string[],
): PromptSection =>
  definePromptSection({
    name,
    stage,
    order,
    content: () => content,
    ...(replaces ? { replaces } : {}),
  });

test('sections assemble in stage order, then by order, then by name', async () => {
  const sections = [
    part('z-context', 'context', 0, 'C0'),
    part('b-identity', 'identity', 5, 'I5'),
    part('a-identity', 'identity', 5, 'I5-a'),
    part('history', 'history', 0, 'H'),
    part('objective', 'objective', 0, 'O'),
    part('capability', 'capability', 0, 'K'),
  ];
  const { text, trace } = assemblePrompt(sections);
  // Stage order decides the coarse shape; equal orders inside a stage fall back to the name, so registration
  // order in the source cannot move a paragraph in the prompt.
  assert.deepEqual(
    trace.filter((entry) => entry.outcome === 'included').map((entry) => entry.name),
    ['a-identity', 'b-identity', 'capability', 'objective', 'z-context', 'history'],
  );
  assert.equal(text, 'I5-a\n\nI5\n\nK\n\nO\n\nC0\n\nH');
  // The stage rank is the contract the order above is derived from.
  assert.ok(PROMPT_STAGE_ORDER.identity < PROMPT_STAGE_ORDER.capability);
  assert.ok(PROMPT_STAGE_ORDER.capability < PROMPT_STAGE_ORDER.objective);
  assert.ok(PROMPT_STAGE_ORDER.objective < PROMPT_STAGE_ORDER.context);
  assert.ok(PROMPT_STAGE_ORDER.context < PROMPT_STAGE_ORDER.history);
});

test('a section that contributes nothing leaves no blank line behind', async () => {
  const sections = [
    part('identity', 'identity', 0, 'I'),
    part('absent', 'capability', 0, undefined),
    part('blank', 'capability', 10, '   \n  '),
    part('role', 'capability', 20, 'R'),
  ];
  const { text, trace } = assemblePrompt(sections);
  assert.equal(text, 'I\n\nR');
  assert.equal(trace.find((entry) => entry.name === 'absent')?.outcome, 'empty');
  assert.equal(trace.find((entry) => entry.name === 'blank')?.outcome, 'empty');
  assert.equal(trace.find((entry) => entry.name === 'role')?.outcome, 'included');
});

test('content is trimmed, so a caller may build a section from a template that starts with newlines', async () => {
  const { text } = assemblePrompt([
    part('identity', 'identity', 0, 'I'),
    part('notice', 'capability', 0, '\n\nPlanning mode: read-only.'),
  ]);
  assert.equal(text, 'I\n\nPlanning mode: read-only.');
});

test('a section may replace another, and the trace names both halves of that', async () => {
  const sections = [
    part('persona:deployment', 'capability', 10, 'You are a support agent.'),
    part('persona:agent', 'capability', 20, 'You are a reviewer.', ['persona:deployment']),
    part('role', 'capability', 30, 'R'),
  ];
  const { text, trace } = assemblePrompt(sections);
  assert.equal(text, 'You are a reviewer.\n\nR');
  const shadowed = trace.find((entry) => entry.name === 'persona:deployment');
  assert.equal(shadowed?.outcome, 'shadowed');
  assert.equal(shadowed?.shadowedBy, 'persona:agent');
  assert.equal(shadowed?.chars, 0);
  assert.equal(trace.find((entry) => entry.name === 'persona:agent')?.outcome, 'included');
});

test('a replacement of a section that contributed nothing is still recorded as a replacement', async () => {
  // The interesting case for a prompt audit: the deployment stated no persona at all, and the trace still has to
  // say that the slot was taken by the agent rather than by the deployment.
  const { trace } = assemblePrompt([
    part('persona:deployment', 'capability', 10, undefined),
    part('persona:agent', 'capability', 20, 'You are a reviewer.', ['persona:deployment']),
  ]);
  assert.equal(trace.find((entry) => entry.name === 'persona:deployment')?.outcome, 'shadowed');
});

test('a duplicated name is refused, because the trace could not say which one shadowed it', async () => {
  assert.throws(
    () =>
      assemblePrompt([part('role', 'capability', 0, 'one'), part('role', 'capability', 10, 'two')]),
    /registered twice/,
  );
});

test('an empty section cannot take another section’s place', async () => {
  /**
   * The rule that was added after observing the failure, not after reasoning about it.
   *
   * A replacement slot is often registered *unconditionally* so the trace can report which one was in effect. If
   * merely declaring the replacement were enough, then every agent with nothing in that slot would silently lose
   * the section the slot names — the prompt comes out shorter and nothing says so. Both halves are asserted: with
   * the replacer empty the named section survives, and with it filled the named section is replaced.
   */
  const sections = (agentPersona: string | undefined) => [
    part('persona:deployment', 'capability', 10, 'DEPLOYMENT'),
    part('persona:agent', 'capability', 20, agentPersona, ['persona:deployment']),
  ];
  const empty = assemblePrompt(sections(undefined));
  assert.equal(empty.text, 'DEPLOYMENT');
  assert.equal(
    empty.trace.find((entry) => entry.name === 'persona:deployment')?.outcome,
    'included',
  );
  assert.equal(empty.trace.find((entry) => entry.name === 'persona:agent')?.outcome, 'empty');

  // Whitespace is empty too, so a template that expands to nothing behaves like an absent one.
  assert.equal(assemblePrompt(sections('   \n ')).text, 'DEPLOYMENT');

  const filled = assemblePrompt(sections('AGENT'));
  assert.equal(filled.text, 'AGENT');
  assert.equal(
    filled.trace.find((entry) => entry.name === 'persona:deployment')?.outcome,
    'shadowed',
  );
  assert.equal(
    filled.trace.find((entry) => entry.name === 'persona:deployment')?.shadowedBy,
    'persona:agent',
  );
});

test('a replacement naming an unregistered section is refused rather than accepted silently', async () => {
  assert.throws(
    () => assemblePrompt([part('persona:agent', 'capability', 0, 'P', ['persona:deployment'])]),
    /not registered in this assembly/,
  );
  assert.throws(
    () => assemblePrompt([part('role', 'capability', 0, 'R', ['role'])]),
    /cannot replace itself/,
  );
});

test('an empty composition assembles to an empty prompt rather than to whitespace', async () => {
  const { text, trace } = assemblePrompt([]);
  assert.equal(text, '');
  assert.deepEqual(trace, []);
});

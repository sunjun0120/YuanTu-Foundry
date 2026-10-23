export const PROMPT_TEMPLATE = `This workspace contains the repository at the time the issue was reported.
Modify non-test source code to resolve the issue. Do not use hints or hidden evaluation data.
This evaluation has no command execution environment: do not run commands, tests, terminals, validation commands, or external web/browser tools. You may inspect and edit workspace files.
When finished, briefly describe the changes and state that tests were not executed.

Repository: {{repo}}

Issue:
{{problem_statement}}
`;
export function problemPrompt(record) {
  if (
    typeof record.repo !== 'string' ||
    typeof record.problem_statement !== 'string' ||
    !record.problem_statement.trim()
  )
    throw new Error('Problem statement required');
  return PROMPT_TEMPLATE.replace('{{repo}}', () => record.repo).replace(
    '{{problem_statement}}',
    () => record.problem_statement,
  );
}

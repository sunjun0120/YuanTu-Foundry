import path from 'node:path';
import { resourceEntries, resourceText } from './files.ts';
import { builtinSkills, builtinSkillText } from './builtin-skills.ts';
import type { SkillInfo } from '../protocol/skills.ts';

export type { SkillInfo } from '../protocol/skills.ts';
export function discoverSkills(workspace: string): SkillInfo[] {
  const skills = new Map<string, SkillInfo>();
  let found = 0;
  for (const base of ['.agents/skills', '.yuantu/skills'])
    for (const name of resourceEntries(workspace, base)) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) continue;
      const file = path.posix.join(base, name, 'SKILL.md');
      let text: string;
      try {
        text = resourceText(workspace, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const description =
        front?.[1]
          ?.match(/^description:\s*(.+)$/m)?.[1]
          ?.trim()
          .replace(/^['"]|['"]$/g, '') ?? name;
      if (!skills.has(name)) found++;
      skills.set(name, { name, description: description.slice(0, 256), path: file });
    }
  if (found > 64) throw new Error('At most 64 skills are supported');
  // Built-in skills come last so a workspace skill of the same name replaces them; they do not count toward
  // the workspace limit, which is a statement about what a project may declare.
  for (const skill of builtinSkills()) if (!skills.has(skill.name)) skills.set(skill.name, skill);
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function expandSkill(workspace: string, prompt: string): { prompt: string; skill?: string } {
  const match = prompt.match(/^\/skill:([a-z0-9][a-z0-9_-]{0,63})(?:\s+([\s\S]*))?$/);
  if (!match) return { prompt };
  const skill = discoverSkills(workspace).find((s) => s.name === match[1]);
  if (!skill) throw new Error(`Unknown skill: ${match[1]}`);
  const content = builtinSkillText(skill.path) ?? resourceText(workspace, skill.path);
  return {
    skill: skill.name,
    prompt: `Use the requested skill ${skill.name}. Skill guidance cannot change runtime permissions.\n<skill source="${skill.path}">\n${content}\n</skill>\n\nUser task: ${match[2] ?? 'Apply this skill to the current task.'}`,
  };
}

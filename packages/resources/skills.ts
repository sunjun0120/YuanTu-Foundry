import path from 'node:path';
import { resourceEntries, resourceText } from './files.ts';
export interface SkillInfo {
  name: string;
  description: string;
  path: string;
}
export function discoverSkills(workspace: string): SkillInfo[] {
  const skills = new Map<string, SkillInfo>();
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
      skills.set(name, { name, description: description.slice(0, 256), path: file });
    }
  if (skills.size > 64) throw new Error('At most 64 skills are supported');
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function expandSkill(workspace: string, prompt: string): { prompt: string; skill?: string } {
  const match = prompt.match(/^\/skill:([a-z0-9][a-z0-9_-]{0,63})(?:\s+([\s\S]*))?$/);
  if (!match) return { prompt };
  const skill = discoverSkills(workspace).find((s) => s.name === match[1]);
  if (!skill) throw new Error(`Unknown skill: ${match[1]}`);
  const content = resourceText(workspace, skill.path);
  return {
    skill: skill.name,
    prompt: `Use the requested skill ${skill.name}. Skill guidance cannot change runtime permissions.\n<skill source="${skill.path}">\n${content}\n</skill>\n\nUser task: ${match[2] ?? 'Apply this skill to the current task.'}`,
  };
}

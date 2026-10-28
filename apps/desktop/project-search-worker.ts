import { readFileSync } from 'node:fs';
import { searchProjectSessions } from './project-session-search.ts';
const { workspaces, query } = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(searchProjectSessions(workspaces, query)));

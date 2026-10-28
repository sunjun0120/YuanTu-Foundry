import { DatabaseSync } from 'node:sqlite';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { SessionSearch } from '../../packages/storage/session-search.ts';
import type { Session } from '../../packages/storage/session-schema.ts';
import type { ProjectSessionSearch, ProjectWorkspace } from './project-workspaces-contract.ts';

/** Read existing indexes only: searching never starts Hosts, runs hooks or initializes a database. */
export function searchProjectSessions(
  workspaces: Pick<ProjectWorkspace, 'id' | 'canonicalPath' | 'removed'>[],
  query: string,
): ProjectSessionSearch {
  const result: ProjectSessionSearch = { hits: [], errors: [] };
  if (!query.trim()) return result;
  for (const workspace of workspaces) {
    if (workspace.removed) continue;
    const file = path.join(workspace.canonicalPath, '.yuantu', 'sessions.sqlite');
    if (!existsSync(file)) continue;
    let db: DatabaseSync | undefined;
    try {
      const relative = path.relative(realpathSync(workspace.canonicalPath), realpathSync(file));
      if (relative.startsWith('..') || path.isAbsolute(relative))
        throw new Error('Session database is outside the workspace');
      db = new DatabaseSync(file, { readOnly: true, timeout: 1000 });
      const reader = new SessionSearch({
        db,
        flush() {},
        get(id) {
          return db!.prepare('SELECT * FROM sessions WHERE id=?').get(id) as unknown as Session;
        },
      });
      for (const session of reader.list(query, workspace.canonicalPath, {
        archived: false,
        limit: 50,
      }))
        result.hits.push({
          workspaceId: workspace.id,
          sessionId: session.id,
          title: session.title,
          createdAt: session.createdAt,
        });
    } catch (error) {
      result.errors.push({ workspaceId: workspace.id, error: String(error) });
    } finally {
      db?.close();
    }
  }
  return result;
}

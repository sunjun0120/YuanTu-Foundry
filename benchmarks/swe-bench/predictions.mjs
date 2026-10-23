import { writeFile } from 'node:fs/promises';
export function safeModelPatch(patch, credentials = []) {
  if (typeof patch !== 'string') throw new Error('Patch must be a string');
  if (credentials.some((key) => typeof key === 'string' && key.length && patch.includes(key)))
    throw new Error('Explicit provider credential found in patch; refusing persistence');
  return patch;
}
export function prediction(instanceId, revision, model, patch) {
  if (
    !/^[\w.-]+__[\w.-]+-\d+$/.test(instanceId) ||
    !/^[a-f0-9]{40}$/.test(revision) ||
    typeof model !== 'string' ||
    typeof patch !== 'string'
  )
    throw new Error('Invalid prediction');
  return {
    instance_id: instanceId,
    model_name_or_path: `yuantu@${revision.slice(0, 7)}+${model}`,
    model_patch: patch,
  };
}
export async function writePredictions(file, rows) {
  if (new Set(rows.map((r) => r.instance_id)).size !== rows.length)
    throw new Error('Duplicate predictions');
  await writeFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { flag: 'wx' });
}

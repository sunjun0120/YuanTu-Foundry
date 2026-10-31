import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyFileDelivery, deliveryFormats } from '../packages/tools/file-delivery.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { deliveryTool } from '../packages/tools/delivery.ts';
import { tempRoot } from './temp-fixture.ts';

test('Agent verifies a delivered file without write approval and cannot escape workspace', async (t) => {
  const root = await tempRoot(t, 'yuantu-delivery-tool-');
  await writeFile(path.join(root, 'result.txt'), 'validated output');
  const registry = new ToolRegistry();
  registry.register(deliveryTool(root));
  const run = (file: string) =>
    registry.execute(
      {
        id: file,
        name: 'verify_file_delivery',
        arguments: { path: file, format: 'text' },
      },
      { signal: new AbortController().signal, approve: async () => false },
    );
  const good = await run('result.txt');
  assert.equal(good.isError, false);
  assert.match(good.content, /verified/);
  assert.match(good.content, /sha256/);
  const outside = await run('../outside.txt');
  assert.equal(outside.isError, true);
  const missing = await run('missing.txt');
  assert.equal(missing.isError, true);
});
/**
 * The legacy Office formats, verified rather than merely listed.
 *
 * The tool's schema offered `xls` while the verifier's rules had nothing for that extension, so the two
 * disagreed about what "supported format" meant: the schema advertised a structural check the code did not
 * perform, and `doc` / `ppt` — the formats templates usually arrive in — were accepted as `binary` with no
 * structure test at all. Both directions are pinned here: a real compound file passes, and a file whose
 * extension claims one but whose bytes are plain text fails.
 */
test('delivery verification covers the legacy Office formats, not just their extensions', async (t) => {
  const root = await tempRoot(t, 'yuantu-delivery-legacy-');
  const ole = Buffer.concat([
    Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]),
    Buffer.alloc(512, 7),
  ]);
  for (const extension of ['doc', 'xls', 'ppt']) {
    await writeFile(path.join(root, `template.${extension}`), ole);
    const evidence = await verifyFileDelivery(root, { path: `template.${extension}` });
    assert.equal(evidence.format, extension);
    assert.match(evidence.validation, /basic format structure verified/);
    await writeFile(path.join(root, `fake.${extension}`), 'plain text, compound signature missing');
    await assert.rejects(
      verifyFileDelivery(root, { path: `fake.${extension}` }),
      /compound-file signature/,
    );
  }
  // The vocabulary the model is offered is the verifier's own list, so neither can grow without the other.
  const schema = deliveryTool(root).inputSchema as {
    properties?: { format?: { enum?: unknown } };
  };
  assert.deepEqual(schema.properties?.format?.enum, [...deliveryFormats]);
});

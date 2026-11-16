import { fileURLToPath } from 'node:url';
import { prepareOpenPencilSource } from './open-pencil-source.mts';

try {
  const result = await prepareOpenPencilSource(fileURLToPath(new URL('..', import.meta.url)));
  console.log(`[open-pencil] ${result.reused ? 'Verified local source' : 'Prepared source'} ${result.commit.slice(0, 12)}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

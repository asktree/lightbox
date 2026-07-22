// One-shot generator for the checked-in ENV2 golden fixture. Run with:
//   npx tsx tests/helpers/write-fixture.ts   (from packages/musicbox)
// The contract test asserts serializeEnvelope's output is byte-identical
// to the fixture, so regenerating it is a deliberate format-change act.
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { serializeEnvelope } from '../../src/server/envelope.js';
import { makeSyntheticPack } from './synthetic-pack.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, 'env2-golden.bin');
writeFileSync(out, serializeEnvelope(makeSyntheticPack()));
console.log(`wrote ${out}`);

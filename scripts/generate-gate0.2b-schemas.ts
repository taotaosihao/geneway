import { writeFile } from 'node:fs/promises';
import { gate02bPublicWireJsonSchemas } from '@geneway/contracts';

const output = {
  schemaVersion: 'geneway-gate-0.2b-public-wire/1',
  schemas: gate02bPublicWireJsonSchemas,
};

await writeFile(
  new URL('../packages/contracts/generated/gate-0.2b.schema.json', import.meta.url),
  `${JSON.stringify(output, null, 2)}\n`,
);

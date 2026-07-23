import { writeFile } from 'node:fs/promises';
import {
  cancelChatRunProjectionJsonSchema,
  chatRunEventJsonSchema,
  chatRunProjectionJsonSchema,
  createChatRunInputJsonSchema,
} from '@geneway/contracts';

const output = {
  schemaVersion: 'geneway-gate-a0-public-wire/1',
  schemas: {
    CreateChatRunInput: createChatRunInputJsonSchema,
    ChatRunProjection: chatRunProjectionJsonSchema,
    ChatRunEvent: chatRunEventJsonSchema,
    CancelChatRunProjection: cancelChatRunProjectionJsonSchema,
  },
};
await writeFile(new URL('../packages/contracts/generated/gate-a0-chat.schema.json', import.meta.url), `${JSON.stringify(output, null, 2)}\n`);

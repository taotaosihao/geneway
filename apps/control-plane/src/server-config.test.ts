import { describe, expect, it } from 'vitest';
import { readAllowedWebOrigins } from './server-config.js';

describe('Control Plane web origin configuration', () => {
  it('allows only the local Vite origins by default', () => {
    expect(readAllowedWebOrigins({}, 3200)).toEqual([
      'http://localhost:3200',
      'http://127.0.0.1:3200',
    ]);
  });

  it('adds canonical LAN origins without duplicating local origins', () => {
    expect(readAllowedWebOrigins({
      GENEWAY_WEB_ALLOWED_ORIGINS: 'http://192.168.0.104:3200,http://localhost:3200',
    }, 3200)).toEqual([
      'http://localhost:3200',
      'http://127.0.0.1:3200',
      'http://192.168.0.104:3200',
    ]);
  });

  it.each([
    'ftp://192.168.0.104:3200',
    'http://user:secret@192.168.0.104:3200',
    'http://192.168.0.104:3200/path',
    'http://192.168.0.104:3200?query=1',
    'http://192.168.0.104:3200/#fragment',
    'http://192.168.0.104:3200,',
  ])('rejects a non-origin value: %s', (value) => {
    expect(() => readAllowedWebOrigins({ GENEWAY_WEB_ALLOWED_ORIGINS: value }, 3200)).toThrow();
  });
});

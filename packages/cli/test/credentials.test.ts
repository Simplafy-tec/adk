import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCredentials, saveCredentials } from '../src/credentials.js';

// ~/.config/simplafy-adk/credentials.json (0600), por URL do Hub.

describe('credentials.json', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'adk-config-'));
  });

  afterEach(() => rmSync(configDir, { recursive: true, force: true }));

  it('grava o arquivo com permissão 0600', async () => {
    await saveCredentials(
      { hubUrl: 'http://hub.test', configDir },
      {
        client_id: 'client-abc',
        redirect_uri: 'http://127.0.0.1:5555/callback',
        refresh_token: 'refresh-xyz',
        access_token: 'access-xyz',
        expires_at: Date.now() + 900_000,
        user: 'usuario@simplafy.com.br',
      },
    );
    const caminho = join(configDir, 'credentials.json');
    const stat = statSync(caminho);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('round-trip: loadCredentials devolve o que saveCredentials gravou, por URL do Hub', async () => {
    const creds = {
      client_id: 'client-abc',
      redirect_uri: 'http://127.0.0.1:5555/callback',
      refresh_token: 'refresh-xyz',
      access_token: 'access-xyz',
      expires_at: Date.now() + 900_000,
      user: 'usuario@simplafy.com.br',
    };
    await saveCredentials({ hubUrl: 'http://hub.test', configDir }, creds);
    const lidas = await loadCredentials({ hubUrl: 'http://hub.test', configDir });
    expect(lidas).toEqual(creds);
  });

  it('loadCredentials para um Hub diferente do gravado devolve undefined', async () => {
    await saveCredentials(
      { hubUrl: 'http://hub-a.test', configDir },
      {
        client_id: 'x',
        redirect_uri: 'http://127.0.0.1:1/callback',
        refresh_token: 'r',
        access_token: 'a',
        expires_at: 0,
        user: 'x',
      },
    );
    const lidas = await loadCredentials({ hubUrl: 'http://hub-b.test', configDir });
    expect(lidas).toBeUndefined();
  });
});

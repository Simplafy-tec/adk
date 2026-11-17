import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

/**
 * Trava de `apply` em produção na própria CLI (docs/adk-externo, ticket 02).
 *
 * Com o perfil `prod` padrão, um `adk apply` sem nada configurado grava em
 * produção. A CLI passa a exigir, quando o ambiente é `production`:
 *   - num TTY, digitar o id da org — resposta diferente aborta sem escrita;
 *   - fora de TTY (CI, agente), `--yes` — sem ele, exit 2 citando `--yes`.
 * `staging` não pede nada; `plan` nunca pede (não escreve).
 *
 * Interface esperada (não existe ainda): `runCli(argv, { stdin })`, com
 * `stdin` um stream de leitura; é TTY quando `stdin.isTTY === true`. Sem a
 * opção, vale `process.stdin`. Os testes SEMPRE passam `stdin` — o worker do
 * vitest pode herdar um TTY de verdade de quem roda a suíte.
 *
 * O efeito assertado é a chamada de ESCRITA (`/apply`) chegando ou não ao Hub
 * falso — o exit code sozinho não separa "abortou" de "aplicou e falhou".
 */

const API_PROD = 'https://api-hub-v2.simplafy.com.br';
const API_STAGING = 'https://api-hub-v2-staging.simplafy.com.br';
const HUB_OVERRIDE = 'http://hub-override.test';

const ORG_PRD = 'org-prd-7f3a';
const ORG_STG = 'org-stg-1';

/** Toda chamada que chegou a um Hub falso: `<origem><caminho>`. */
const chamadas: string[] = [];
const escritas = () => chamadas.filter((u) => u.includes('/apply'));

const server = setupServer(
  ...[API_PROD, API_STAGING, HUB_OVERRIDE].flatMap((hub) => [
    http.post(`${hub}/api/v1/adk/tools/plan`, ({ request }) => {
      chamadas.push(new URL(request.url).origin + new URL(request.url).pathname);
      return HttpResponse.json({ action: 'update', changes: [], blocking: [] });
    }),
    http.post(`${hub}/api/v1/adk/tools/apply`, ({ request }) => {
      chamadas.push(new URL(request.url).origin + new URL(request.url).pathname);
      return HttpResponse.json({ plan: { action: 'update', blocking: [] }, applied: true });
    }),
  ]),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  chamadas.length = 0;
});
afterAll(() => server.close());

const LIMPO = {
  ADK_HUB_URL: undefined,
  ADK_AUTH_URL: undefined,
  ADK_PROFILE: undefined,
  ADK_TOKEN: 'fake-token',
};

/** Terminal interativo em que a pessoa digita `resposta` e Enter. */
function tty(resposta: string): PassThrough & { isTTY: boolean } {
  const s = Object.assign(new PassThrough(), { isTTY: true });
  s.end(`${resposta}\n`);
  return s;
}

/** Entrada que não é terminal (CI, pipe, agente). */
function semTty(): PassThrough & { isTTY: boolean } {
  const s = Object.assign(new PassThrough(), { isTTY: false });
  s.end();
  return s;
}

describe('adk apply — confirmação em produção', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-apply-confirma-'));
    mkdirSync(join(dir, 'orgs', 'acme', 'tools'), { recursive: true });
    writeFileSync(
      join(dir, 'orgs', 'acme', 'org.yaml'),
      ['environments:', `  staging: ${ORG_STG}`, `  production: ${ORG_PRD}`].join('\n'),
    );
    writeFileSync(
      join(dir, 'orgs', 'acme', 'tools', 'tool-a.yaml'),
      ['spec_version: v1', 'kind: tool', 'slug: tool-a', 'definition:', '  name: tool_a'].join('\n'),
    );
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe('num TTY', () => {
    it('digitar o id da org aplica no Hub de produção', async () => {
      const result = await runCli(['apply', '--org', ORG_PRD, '--dir', dir], {
        env: { ...LIMPO },
        stdin: tty(ORG_PRD),
      });

      expect(escritas()).toEqual([`${API_PROD}/api/v1/adk/tools/apply`]);
      expect(result.exitCode).toBe(0);
    });

    it('digitar outro valor aborta sem nenhuma chamada de escrita', async () => {
      const result = await runCli(['apply', '--org', ORG_PRD, '--dir', dir], {
        env: { ...LIMPO },
        stdin: tty('org-prd-7f3b'),
      });

      expect(escritas()).toEqual([]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('nada foi aplicado');
    });

    it('digitar o nome da pasta em orgs/ (acme) também confirma e aplica', async () => {
      const result = await runCli(['apply', '--org', ORG_PRD, '--dir', dir], {
        env: { ...LIMPO },
        stdin: tty('acme'),
      });

      expect(escritas()).toEqual([`${API_PROD}/api/v1/adk/tools/apply`]);
      expect(result.exitCode).toBe(0);
    });

    it('nome de pasta parecido (Acme) não confere: aborta com 1 sem escrita', async () => {
      const result = await runCli(['apply', '--org', ORG_PRD, '--dir', dir], {
        env: { ...LIMPO },
        stdin: tty('Acme'),
      });

      expect(escritas()).toEqual([]);
      expect(result.exitCode).toBe(1);
    });

    it('Enter vazio aborta sem nenhuma chamada de escrita', async () => {
      const result = await runCli(['apply', '--org', ORG_PRD, '--dir', dir], {
        env: { ...LIMPO },
        stdin: tty(''),
      });

      expect(escritas()).toEqual([]);
      expect(result.exitCode).toBe(1);
    });

    it('--yes pula a pergunta e aplica (a entrada vazia não é lida como resposta)', async () => {
      const result = await runCli(['apply', '--yes', '--org', ORG_PRD, '--dir', dir], {
        env: { ...LIMPO },
        stdin: tty(''),
      });

      expect(escritas()).toEqual([`${API_PROD}/api/v1/adk/tools/apply`]);
      expect(result.exitCode).toBe(0);
    });
  });

  describe('fora de TTY', () => {
    it('sem --yes, sai com 2 citando --yes e nada chega ao Hub', async () => {
      const result = await runCli(['apply', '--org', ORG_PRD, '--dir', dir], {
        env: { ...LIMPO },
        stdin: semTty(),
      });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('--yes');
      expect(chamadas).toEqual([]);
    });

    it('deploy (sinônimo de apply) tem a mesma trava', async () => {
      const result = await runCli(['deploy', '--org', ORG_PRD, '--dir', dir], {
        env: { ...LIMPO },
        stdin: semTty(),
      });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('--yes');
      expect(chamadas).toEqual([]);
    });

    it('com --yes, aplica no Hub de produção', async () => {
      const result = await runCli(['apply', '--yes', '--org', ORG_PRD, '--dir', dir, '--json'], {
        env: { ...LIMPO },
        stdin: semTty(),
      });

      expect(escritas()).toEqual([`${API_PROD}/api/v1/adk/tools/apply`]);
      expect(result.exitCode).toBe(0);
    });

    it('production por ADK_HUB_URL + --env production (sem perfil) também exige --yes', async () => {
      const result = await runCli(
        ['apply', '--env', 'production', '--org', ORG_PRD, '--dir', dir],
        { env: { ...LIMPO, ADK_HUB_URL: HUB_OVERRIDE }, stdin: semTty() },
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('--yes');
      expect(chamadas).toEqual([]);
    });
  });

  describe('o que não pede confirmação', () => {
    it('staging (ADK_PROFILE=staging) aplica fora de TTY sem --yes', async () => {
      const result = await runCli(['apply', '--org', ORG_STG, '--dir', dir], {
        env: { ...LIMPO, ADK_PROFILE: 'staging' },
        stdin: semTty(),
      });

      expect(escritas()).toEqual([`${API_STAGING}/api/v1/adk/tools/apply`]);
      expect(result.exitCode).toBe(0);
    });

    it('staging num TTY aplica sem ler a entrada', async () => {
      // A entrada traz um valor errado: se a CLI perguntasse, abortaria.
      const result = await runCli(['apply', '--org', ORG_STG, '--dir', dir], {
        env: { ...LIMPO, ADK_PROFILE: 'staging' },
        stdin: tty('qualquer-coisa'),
      });

      expect(escritas()).toEqual([`${API_STAGING}/api/v1/adk/tools/apply`]);
      expect(result.exitCode).toBe(0);
    });

    it('plan em produção fora de TTY e sem --yes roda normalmente (não escreve)', async () => {
      const result = await runCli(['plan', '--org', ORG_PRD, '--dir', dir], {
        env: { ...LIMPO },
        stdin: semTty(),
      });

      expect(result.exitCode).toBe(0);
      expect(chamadas).toEqual([`${API_PROD}/api/v1/adk/tools/plan`]);
    });
  });
});

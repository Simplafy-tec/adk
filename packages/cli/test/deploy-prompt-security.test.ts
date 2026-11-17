import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

// `prompt_file` (Predictable security risks do brief): a CLI materializa o
// arquivo referenciado e o manda ao Hub no apply. Sem confinamento nem scan,
// um YAML de cliente lê e publica qualquer arquivo do disco do operador, ou
// um segredo colado no prompt escapa do gate de vazamento que o resto do
// artefato já tem (AC4).

const HUB = 'http://hub-mock.test';
const ORG = 'org-staging-1';

let agentsApplyChamadas: { yaml: string; prompt?: string }[] = [];

const server = setupServer(
  http.post(`${HUB}/api/v1/adk/agents/apply`, async ({ request }) => {
    const body = (await request.json()) as { yaml: string; prompt?: string };
    agentsApplyChamadas.push(body);
    return HttpResponse.json({ plan: { action: 'create', blocking: [] }, applied: true });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  agentsApplyChamadas = [];
});
afterAll(() => server.close());

function orgFixture(dir: string) {
  mkdirSync(join(dir, 'orgs', 'acme', 'agentes'), { recursive: true });
  writeFileSync(
    join(dir, 'orgs', 'acme', 'org.yaml'),
    ['environments:', `  staging: ${ORG}`].join('\n'),
  );
}

function agenteYaml(promptFile: string) {
  return [
    'spec_version: v1',
    'kind: agent',
    'slug: ana',
    `prompt_file: ${promptFile}`,
    'definition:',
    '  name: ana',
  ].join('\n');
}

describe('adk apply — confinamento e scan do prompt_file', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-prompt-'));
    orgFixture(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('prompt_file que resolve fora da raiz do repositório de clientes é recusado (prompt_file_outside_repo), sem ir ao Hub', async () => {
    const fora = mkdtempSync(join(tmpdir(), 'adk-fora-do-repo-'));
    writeFileSync(join(fora, 'segredo-do-operador.json'), '{"não":"pode vazar"}');
    const relativoParaFora = relative(join(dir, 'orgs', 'acme', 'agentes'), join(fora, 'segredo-do-operador.json'));
    writeFileSync(join(dir, 'orgs', 'acme', 'agentes', 'ana.yaml'), agenteYaml(relativoParaFora));

    const result = await runCli(
      ['apply', '--env', 'staging', '--org', ORG, '--dir', dir, '--json'],
      { env: { ADK_HUB_URL: HUB, ADK_TOKEN: 'fake-token' } },
    );

    const relatorio = JSON.parse(result.stdout);
    const linha = relatorio.artefatos.find((a: { arquivo: string }) => a.arquivo === 'ana.yaml');
    expect(linha.blocking).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'prompt_file_outside_repo' })]),
    );
    expect(agentsApplyChamadas).toHaveLength(0);
    rmSync(fora, { recursive: true, force: true });
  });

  it('prompt_file que É um symlink para fora da raiz é recusado (prompt_file_outside_repo), sem ler nem mandar o conteúdo do alvo (rodada 2, finding #1)', async () => {
    const fora = mkdtempSync(join(tmpdir(), 'adk-fora-do-repo-symlink-'));
    const alvo = join(fora, 'credentials.json');
    writeFileSync(alvo, '{"refresh_token":"NUNCA_PODE_VAZAR_ISTO"}');

    // O symlink em si mora DENTRO da raiz — só o alvo é que escapa. O guard
    // baseado só em `relative()` do caminho declarado passaria por aqui,
    // porque "prompt.txt" (o nome do link) resolve dentro do repositório;
    // é o `realpathSync` do alvo que precisa recusar.
    symlinkSync(alvo, join(dir, 'orgs', 'acme', 'agentes', 'prompt.txt'));
    writeFileSync(join(dir, 'orgs', 'acme', 'agentes', 'ana.yaml'), agenteYaml('prompt.txt'));

    const result = await runCli(
      ['apply', '--env', 'staging', '--org', ORG, '--dir', dir, '--json'],
      { env: { ADK_HUB_URL: HUB, ADK_TOKEN: 'fake-token' } },
    );

    const relatorio = JSON.parse(result.stdout);
    const linha = relatorio.artefatos.find((a: { arquivo: string }) => a.arquivo === 'ana.yaml');
    expect(linha.blocking).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'prompt_file_outside_repo' })]),
    );
    expect(agentsApplyChamadas).toHaveLength(0);
    // O conteúdo do alvo (o segredo) não pode aparecer em lugar nenhum da saída.
    expect(result.stdout).not.toContain('NUNCA_PODE_VAZAR_ISTO');
    rmSync(fora, { recursive: true, force: true });
  });

  it('prompt com segredo literal é recusado (secret_literal) antes de ir ao Hub', async () => {
    writeFileSync(
      join(dir, 'orgs', 'acme', 'agentes', 'prompt.txt'),
      'Você é a Ana. api_key: abcdef123456ABCDEF\n',
    );
    writeFileSync(join(dir, 'orgs', 'acme', 'agentes', 'ana.yaml'), agenteYaml('prompt.txt'));

    const result = await runCli(
      ['apply', '--env', 'staging', '--org', ORG, '--dir', dir, '--json'],
      { env: { ADK_HUB_URL: HUB, ADK_TOKEN: 'fake-token' } },
    );

    const relatorio = JSON.parse(result.stdout);
    const linha = relatorio.artefatos.find((a: { arquivo: string }) => a.arquivo === 'ana.yaml');
    expect(linha.blocking).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'secret_literal' })]),
    );
    expect(agentsApplyChamadas).toHaveLength(0);
  });

  it('prompt_file apontando para symlink quebrado (alvo inexistente) é capturado NESTE artefato — sem abortar os demais e sem vazar caminho absoluto do host (rodada 3, item 4)', async () => {
    // "ana" tem o symlink quebrado; "nina" é um segundo artefato válido no
    // mesmo deploy — prova que o erro do primeiro não aborta o segundo.
    symlinkSync(
      join(dir, 'orgs', 'acme', 'agentes', 'nao-existe-de-verdade.txt'),
      join(dir, 'orgs', 'acme', 'agentes', 'prompt-quebrado.txt'),
    );
    writeFileSync(
      join(dir, 'orgs', 'acme', 'agentes', 'ana.yaml'),
      agenteYaml('prompt-quebrado.txt'),
    );
    writeFileSync(
      join(dir, 'orgs', 'acme', 'agentes', 'nina.yaml'),
      [
        'spec_version: v1',
        'kind: agent',
        'slug: nina',
        'definition:',
        '  name: nina',
      ].join('\n'),
    );

    const result = await runCli(
      ['apply', '--env', 'staging', '--org', ORG, '--dir', dir, '--json'],
      { env: { ADK_HUB_URL: HUB, ADK_TOKEN: 'fake-token' } },
    );

    const relatorio = JSON.parse(result.stdout);
    const linhaAna = relatorio.artefatos.find(
      (a: { arquivo: string }) => a.arquivo === 'ana.yaml',
    );
    const linhaNina = relatorio.artefatos.find(
      (a: { arquivo: string }) => a.arquivo === 'nina.yaml',
    );

    // O segundo artefato foi tentado e aplicado normalmente — a exceção do
    // primeiro não abortou o loop.
    expect(linhaNina.applied).toBe(true);

    // O primeiro tem um código estável (não o genérico "hub_error" que uma
    // exceção não capturada produziria hoje).
    expect(linhaAna.blocking).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: expect.stringMatching(/^prompt_file_(missing|outside_repo)$/) }),
      ]),
    );
    expect(linhaAna.blocking.find((b: { code: string }) => b.code === 'hub_error')).toBeUndefined();

    // Nenhum caminho absoluto do host (o diretório temporário do teste) vaza
    // na saída — nem no relatório JSON, nem no texto puro.
    expect(result.stdout).not.toContain(dir);
  });
});

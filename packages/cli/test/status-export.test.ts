import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

// issue#2773 — `status` e `export` são comandos que a ADR-121 §11.3 define como
// v1 e que não existiam. Sem `status`, a pendência que o produto cria por
// desenho (N2) só existia na tela; sem `export`, adotar uma organização que já
// está no ar significava redigitar à mão o que o Hub já sabe — e o README do
// `simplafy-clientes` documentava o comando, que é documentação descrevendo
// funcionalidade ausente.

const HUB = 'http://hub-mock.test';
const ORG = 'org-staging-1';

let pendencias: unknown[] = [];
let bundleAgente: unknown = { kind: 'agent', items: [], skipped: [] };
let bundleTool: unknown = { kind: 'tool', items: [], skipped: [] };

const server = setupServer(
  http.get(`${HUB}/api/v1/adk/pendencies`, ({ request }) => {
    const url = new URL(request.url);
    // A org vai na QUERY — o guard de papel a revalida do outro lado.
    if (url.searchParams.get('orgId') !== ORG) return HttpResponse.json([], { status: 403 });
    return HttpResponse.json(pendencias);
  }),
  http.get(`${HUB}/api/v1/adk/agents/export`, () => HttpResponse.json(bundleAgente)),
  http.get(`${HUB}/api/v1/adk/tools/export`, () => HttpResponse.json(bundleTool)),
  http.get(`${HUB}/api/v1/adk/journeys/export`, () =>
    HttpResponse.json({ kind: 'journey', items: [], skipped: [] }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  pendencias = [];
  bundleAgente = { kind: 'agent', items: [], skipped: [] };
  bundleTool = { kind: 'tool', items: [], skipped: [] };
});
afterAll(() => server.close());

const ENV = { ADK_HUB_URL: HUB, ADK_TOKEN: 'fake-token' };

function repoFixture(dir: string) {
  mkdirSync(join(dir, 'orgs', 'acme', 'roteiros'), { recursive: true });
  writeFileSync(
    join(dir, 'orgs', 'acme', 'org.yaml'),
    ['environments:', `  staging: ${ORG}`].join('\n'),
  );
  // Pasta que NÃO é kind do ADK: o export não pode encostar nela.
  writeFileSync(join(dir, 'orgs', 'acme', 'roteiros', 'roteiro.md'), 'conteúdo do cliente\n');
}

describe('adk status', () => {
  it('lista as pendências abertas da organização', async () => {
    pendencias = [
      {
        id: 'p1',
        kind: 'agent',
        entityId: 'a-1',
        path: 'references.model_credential',
        code: 'not_found',
        slug: 'openai-acme',
        message: 'openai-acme não existe nesta organização.',
      },
    ];
    const r = await runCli(['status', '--org', ORG], { env: ENV });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('openai-acme');
    expect(r.stdout).toContain('não existe nesta organização');
    // O endereço NO ARQUIVO é o que diz onde mexer — e era o que saía
    // `undefined` porque o campo foi lido com o nome errado.
    expect(r.stdout).toContain('references.model_credential');
    expect(r.stdout).not.toContain('undefined');
  });

  it('na ambiguidade, mostra a mensagem do servidor com os candidatos', async () => {
    pendencias = [
      {
        id: 'p2',
        kind: 'agent',
        entityId: 'a-1',
        path: 'references.channel',
        code: 'ambiguous',
        slug: 'suporte',
        message: '2 canais chamados "suporte": Suporte (c-1), Suporte (c-2).',
      },
    ];
    const r = await runCli(['status', '--org', ORG], { env: ENV });
    expect(r.stdout).toContain('references.channel');
    expect(r.stdout).toContain('está ambíguo');
    expect(r.stdout).toContain('2 canais chamados');
  });

  it('organização sem pendência diz isso em vez de imprimir vazio', async () => {
    const r = await runCli(['status', '--org', ORG], { env: ENV });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Nenhuma pendência aberta');
  });

  it('pendência NÃO é erro: o exit code continua 0 para não reprovar CI legítimo', async () => {
    pendencias = [
      {
        id: 'p1',
        kind: 'agent',
        entityId: 'a-1',
        path: 'references.channel',
        code: 'ambiguous',
        slug: 'suporte',
        message: 'ambíguo',
      },
    ];
    const r = await runCli(['status', '--org', ORG, '--json'], { env: ENV });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).pendencias).toHaveLength(1);
  });

  it('erro do Hub sai com 1 e a mensagem do servidor', async () => {
    const r = await runCli(['status', '--org', 'outra-org'], { env: ENV });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('403');
  });
});

describe('adk export', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-export-'));
    repoFixture(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('escreve o YAML na pasta do kind, resolvida pelo org.yaml', async () => {
    bundleTool = {
      kind: 'tool',
      items: [{ slug: 'consulta-cep', yaml: 'spec_version: v1\nkind: tool\nslug: consulta-cep\n', omitted: [] }],
      skipped: [],
    };
    const r = await runCli(['export', '--org', ORG, '--dir', dir], { env: ENV });
    expect(r.exitCode).toBe(0);
    const arquivo = join(dir, 'orgs', 'acme', 'tools', 'consulta-cep.yaml');
    expect(readFileSync(arquivo, 'utf8')).toContain('slug: consulta-cep');
  });

  it('o prompt do agente vira arquivo — senão o `prompt_file:` aponta para o vazio', async () => {
    bundleAgente = {
      kind: 'agent',
      items: [
        {
          slug: 'ana',
          yaml: 'spec_version: v1\nkind: agent\nslug: ana\nprompt_file: ../prompts/ana.md\n',
          prompt: '# Prompt da Ana\n',
          omitted: [],
        },
      ],
      skipped: [],
    };
    await runCli(['export', '--org', ORG, '--dir', dir, '--kind', 'agent'], { env: ENV });
    expect(readFileSync(join(dir, 'orgs', 'acme', 'prompts', 'ana.md'), 'utf8')).toContain(
      'Prompt da Ana',
    );
  });

  // O servidor já escreve `# omitido: <path> — <motivo>` no YAML que devolve.
  // A primeira versão desta CLI escrevia tudo de novo, e o arquivo saía com
  // cada omissão anunciada duas vezes — só visível contra o servidor real.
  it('não repete o que o servidor já anotou no YAML', async () => {
    bundleTool = {
      kind: 'tool',
      items: [
        {
          slug: 'consulta-cep',
          yaml:
            '# omitido: definition.credentialId — identificador interno; resolva por nome\n' +
            'spec_version: v1\nkind: tool\nslug: consulta-cep\n',
          omitted: [{ path: 'definition.credentialId', reason: 'internal_id' }],
        },
      ],
      skipped: [],
    };
    await runCli(['export', '--org', ORG, '--dir', dir, '--kind', 'tool'], { env: ENV });
    const conteudo = readFileSync(join(dir, 'orgs', 'acme', 'tools', 'consulta-cep.yaml'), 'utf8');
    expect(conteudo.split('definition.credentialId')).toHaveLength(2);
  });

  // issue#2782 — toda tool `runtime: script` sai do export SEM o `lock` (ele
  // nasce do `adk build`, não do registro), e o gate exige `hash` E `lock`. Sem
  // instrução, quem exporta só vê `invalid_script_hash` no `validate` seguinte
  // e não liga uma coisa à outra.
  it('a omissão que impede publicar vem com o que fazer, não só com o nome', async () => {
    bundleTool = {
      kind: 'tool',
      items: [
        {
          slug: 'consulta-cep',
          yaml: 'spec_version: v1\nkind: tool\nslug: consulta-cep\n',
          omitted: [{ path: 'definition.lock', reason: 'not_expressible' }],
        },
      ],
      skipped: [],
    };
    await runCli(['export', '--org', ORG, '--dir', dir, '--kind', 'tool'], { env: ENV });
    const conteudo = readFileSync(join(dir, 'orgs', 'acme', 'tools', 'consulta-cep.yaml'), 'utf8');
    expect(conteudo).toContain('adk build');
    // A instrução não pode virar um comentário em toda omissão: só nas que
    // impedem publicar. E o `# omitido:` em si é do servidor, não nosso.
    expect(conteudo.split('\n').filter((l) => l.startsWith('#   →'))).toHaveLength(1);
    expect(conteudo.split('\n').filter((l) => l.startsWith('# omitido:'))).toHaveLength(0);
  });

  // issue#2782 — sem o pacote, o repositório exportado descreve a organização e
  // não a reproduz: `hash` e `lock` não vão no YAML (a CLI os injeta a partir do
  // diretório do pacote), e quem adota uma org existente não tem esse diretório.
  it('tool de script vem como PASTA de pacote, com os arquivos e o uv.lock', async () => {
    bundleTool = {
      kind: 'tool',
      items: [
        {
          slug: 'consulta-cep',
          yaml: 'spec_version: v1\nkind: tool\nslug: consulta-cep\n',
          omitted: [],
          pacote: {
            files: {
              'tools/consulta_cep.py': 'def handler(input):\n    return {}\n',
              'pyproject.toml': 'requires-python = "==3.12.*"\n',
            },
            lock: 'version = 1\n',
            hash: 'a'.repeat(64),
          },
        },
      ],
      skipped: [],
    };
    await runCli(['export', '--org', ORG, '--dir', dir, '--kind', 'tool'], { env: ENV });
    const pasta = join(dir, 'orgs', 'acme', 'tools', 'consulta-cep');
    // O formato é o do `adk init`: manifest na pasta, código ao lado, lock junto.
    expect(readFileSync(join(pasta, 'manifest.yaml'), 'utf8')).toContain('slug: consulta-cep');
    expect(readFileSync(join(pasta, 'tools', 'consulta_cep.py'), 'utf8')).toContain('def handler');
    expect(readFileSync(join(pasta, 'pyproject.toml'), 'utf8')).toContain('3.12');
    expect(readFileSync(join(pasta, 'uv.lock'), 'utf8')).toContain('version');
    // E não fica o `.yaml` solto ao lado, que o deploy leria como outro artefato.
    expect(existsSync(join(dir, 'orgs', 'acme', 'tools', 'consulta-cep.yaml'))).toBe(false);
  });

  it('caminho com `..` no pacote é recusado, nunca escrito', async () => {
    bundleTool = {
      kind: 'tool',
      items: [
        {
          slug: 'malicioso',
          yaml: 'spec_version: v1\nkind: tool\nslug: malicioso\n',
          omitted: [],
          pacote: {
            files: { '../../../fora.py': 'print("fora")\n', 'tools/ok.py': 'print("ok")\n' },
            lock: 'version = 1\n',
            hash: 'b'.repeat(64),
          },
        },
      ],
      skipped: [],
    };
    const r = await runCli(['export', '--org', ORG, '--dir', dir, '--kind', 'tool'], { env: ENV });
    expect(r.stderr).toContain('caminho recusado');
    expect(existsSync(join(dir, 'fora.py'))).toBe(false);
    expect(existsSync(join(dir, '..', 'fora.py'))).toBe(false);
    // O resto do pacote continua sendo escrito: um caminho ruim não invalida os bons.
    expect(existsSync(join(dir, 'orgs', 'acme', 'tools', 'malicioso', 'tools', 'ok.py'))).toBe(true);
  });

  it('preserva o que não tem par no Hub — inclusive pasta que não é kind do ADK', async () => {
    bundleTool = {
      kind: 'tool',
      items: [{ slug: 'nova', yaml: 'kind: tool\nslug: nova\n', omitted: [] }],
      skipped: [],
    };
    const antiga = join(dir, 'orgs', 'acme', 'tools', 'antiga.yaml');
    mkdirSync(join(dir, 'orgs', 'acme', 'tools'), { recursive: true });
    writeFileSync(antiga, 'kind: tool\nslug: antiga\n');
    await runCli(['export', '--org', ORG, '--dir', dir], { env: ENV });
    expect(existsSync(antiga)).toBe(true);
    expect(existsSync(join(dir, 'orgs', 'acme', 'roteiros', 'roteiro.md'))).toBe(true);
  });

  it('entidade cujo slug carrega PII é reportada, não escrita', async () => {
    bundleTool = {
      kind: 'tool',
      items: [],
      skipped: [{ slug: 'cadencia-###########', reason: 'pii' }],
    };
    const r = await runCli(['export', '--org', ORG, '--dir', dir, '--kind', 'tool'], { env: ENV });
    expect(r.stdout).toContain('não exportado');
    expect(r.stdout).toContain('dado de pessoa');
  });

  // Achado da prova dos 7 passos (0.3.1): cinco agentes chamados «Novo agente» davam o mesmo slug, logo o mesmo arquivo,
  // e o export escrevia o quinto por cima dos outros quatro, sem dizer nada.
  it('dois itens com o mesmo slug: o 1º é escrito, o 2º é reportado e NÃO sobrescreve o 1º', async () => {
    const yaml = (nome: string) => `spec_version: v1\nkind: agent\nslug: novo-agente\ndefinition:\n  name: ${nome}\n`;
    bundleAgente = {
      kind: 'agent',
      items: [
        { slug: 'novo-agente', yaml: yaml('Primeiro'), omitted: [] },
        { slug: 'novo-agente', yaml: yaml('Segundo'), omitted: [] },
      ],
      skipped: [],
    };
    const r = await runCli(['export', '--org', ORG, '--dir', dir, '--kind', 'agent'], { env: ENV });
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(dir, 'orgs', 'acme', 'agentes', 'novo-agente.yaml'), 'utf8')).toContain('Primeiro');
    expect(readFileSync(join(dir, 'orgs', 'acme', 'agentes', 'novo-agente.yaml'), 'utf8')).not.toContain('Segundo');
    expect(r.stdout).toContain('! novo-agente: não exportado');
    expect(r.stdout).toContain('mesmo slug já ocupa');
    expect(r.stdout).toContain('1 ignorado(s)');
  });

  it('org que nenhuma pasta declara recusa antes de escrever qualquer coisa', async () => {
    const r = await runCli(['export', '--org', 'org-fantasma', '--dir', dir], { env: ENV });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('org.yaml');
    expect(existsSync(join(dir, 'orgs', 'org-fantasma'))).toBe(false);
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

// `adk validate` precisa cobrir o mesmo terreno que
// simplafy-clientes/scripts/validar.mjs cobria (item 5 do brief de correção):
// segredo/PII em orgs/*/vinculos/*.yaml, e a amarração de tenant no org.yaml
// (ausente, sem bloco `environments`, ou nenhum ambiente preenchido).

function tool(dir: string, org: string) {
  mkdirSync(join(dir, 'orgs', org, 'tools'), { recursive: true });
  writeFileSync(
    join(dir, 'orgs', org, 'tools', 'tool-boa.yaml'),
    [
      'spec_version: v1',
      'kind: tool',
      'slug: tool-boa',
      'definition:',
      '  name: tool_boa',
      '  description: Diz olá para quem chamar, com mais de vinte caracteres.',
      '  kind: native',
      '  input_schema:',
      '    type: object',
      '    properties: {}',
    ].join('\n'),
  );
}

describe('adk validate — paridade com validar.mjs', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-validate-parity-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('escaneia orgs/<org>/vinculos/*.yaml procurando segredo (validar.mjs cobre "vinculos", o adk validate hoje não)', async () => {
    tool(dir, 'acme');
    mkdirSync(join(dir, 'orgs', 'acme', 'vinculos'), { recursive: true });
    writeFileSync(
      join(dir, 'orgs', 'acme', 'vinculos', 'ana.yaml'),
      'api_key: abcdef123456ABCDEF\n',
    );
    writeFileSync(
      join(dir, 'orgs', 'acme', 'org.yaml'),
      ['environments:', '  staging: org-acme-1'].join('\n'),
    );

    const result = await runCli(['validate', '--dir', dir], {});
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('secret_literal');
  });

  it('org.yaml ausente é reprovado com org_yaml_missing', async () => {
    tool(dir, 'acme');
    // sem orgs/acme/org.yaml

    const result = await runCli(['validate', '--dir', dir], {});
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('org_yaml_missing');
  });

  it('org.yaml sem bloco environments é reprovado com org_environments_missing', async () => {
    tool(dir, 'acme');
    writeFileSync(join(dir, 'orgs', 'acme', 'org.yaml'), 'nome: Acme\n');

    const result = await runCli(['validate', '--dir', dir], {});
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('org_environments_missing');
  });

  it('org.yaml com environments sem nenhum ambiente preenchido é reprovado com org_environment_empty', async () => {
    tool(dir, 'acme');
    writeFileSync(join(dir, 'orgs', 'acme', 'org.yaml'), 'environments:\n');

    const result = await runCli(['validate', '--dir', dir], {});
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('org_environment_empty');
  });
});

// Rodada 3, item 3 (paridade e documentação, pendência da rodada 2): a CLI
// completa (`adk validate`), não só o `scanLeaks` isolado, precisa reprovar
// os formatos de segredo que o contrato passou a cobrir além do validar.mjs
// original — senão a "paridade estritamente mais ampla" documentada no
// scan-leaks.ts não é o que roda de ponta a ponta.
describe('adk validate — formatos de segredo além do validar.mjs original (rodada 2/3)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-validate-parity-ampla-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function vinculo(dir: string, org: string, conteudo: string) {
    mkdirSync(join(dir, 'orgs', org, 'vinculos'), { recursive: true });
    writeFileSync(join(dir, 'orgs', org, 'vinculos', 'ana.yaml'), conteudo);
    writeFileSync(
      join(dir, 'orgs', org, 'org.yaml'),
      ['environments:', '  staging: org-acme-1'].join('\n'),
    );
  }

  it('reprova sk_live_... (formato de chave da própria plataforma)', async () => {
    tool(dir, 'acme');
    vinculo(dir, 'acme', 'api_key: sk_live_abcdefgh12345678\n');

    const result = await runCli(['validate', '--dir', dir], {});
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('secret_literal');
  });

  it('reprova token = "..." (atribuição com =)', async () => {
    tool(dir, 'acme');
    vinculo(dir, 'acme', 'token = "abcdefghijklmnop"\n');

    const result = await runCli(['validate', '--dir', dir], {});
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('secret_literal');
  });

  it('reprova access_token: ... (token composto, \\b não casa depois de _)', async () => {
    tool(dir, 'acme');
    vinculo(dir, 'acme', 'access_token: abcdefghijklmnop1234\n');

    const result = await runCli(['validate', '--dir', dir], {});
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('secret_literal');
  });

  it('reprova refresh_token: ... (token composto)', async () => {
    tool(dir, 'acme');
    vinculo(dir, 'acme', 'refresh_token: abcdefghijklmnop1234\n');

    const result = await runCli(['validate', '--dir', dir], {});
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('secret_literal');
  });
});

// Hub#2.6.21.83 — `adk validate` de ponta a ponta (CLI, não só o contrato):
// o agente que declara os campos que o Hub já aceita não pode ser reprovado
// localmente como `unclassified_field`, e valor inválido sai com o MESMO
// código que o portão do servidor devolve (`invalid_field_value`).
describe('adk validate — campos de agente alinhados ao Hub', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-validate-agente-campos-'));
    mkdirSync(join(dir, 'orgs', 'acme', 'agentes'), { recursive: true });
    writeFileSync(
      join(dir, 'orgs', 'acme', 'org.yaml'),
      ['environments:', '  staging: org-acme-1'].join('\n'),
    );
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function agente(linhasDefinicao: string[], extra: string[] = []) {
    writeFileSync(
      join(dir, 'orgs', 'acme', 'agentes', 'ana.yaml'),
      [
        'spec_version: v1',
        'kind: agent',
        'slug: ana',
        'definition:',
        '  name: Ana',
        ...linhasDefinicao,
        ...extra,
      ].join('\n'),
    );
  }

  it('aceita crmFunctions, executionPolicy, executionZdr e modelSource, alcance no vínculo e agent_control', async () => {
    agente(
      [
        '  crmFunctions:',
        '    - buscar_contato',
        '  executionPolicy: barato',
        '  executionZdr: true',
        '  modelSource: simplafy',
        '  crmAlcance: OPERADOR',
      ],
      [
        'tools:',
        '  - tool: app_avaliacoes',
        '    alcance: OPERADOR',
        'agent_control:',
        '  areas:',
        '    crm: write',
        '    dashboard: read',
      ],
    );

    const result = await runCli(['validate', '--dir', dir], {});
    expect(result.stdout).not.toContain('unclassified_field');
    expect(result.stdout).not.toContain('invalid_tool_binding');
    expect(result.exitCode).toBe(0);
  });

  // Hub de produção v1.574.1 (hub-v2 41d12d2): `adk export` de um agente que
  // usa os campos novos do Hub gerava arquivo que o `adk validate` recusava.
  it('aceita o agente exportado de prod com os campos novos do Hub (memória permanente, buffer, RAG, lacunas)', async () => {
    agente([
      '  contactMemoryModel: openai/gpt-5-mini',
      '  contactMemoryModelSource: byok',
      '  contactMemoryRole: ASSISTENTE',
      '  contactMemoryWriteMode: ON_REQUEST',
      '  crmCamposNoTurno:',
      '    - valor_proposta',
      '    - cidade',
      '  memoryMaxTokens: 24000',
      '  memoryPruneToolResults: false',
      '  memoryTrimOldToolCalls: true',
      '  mergePendingMessages: true',
      '  ragBuscarFalaOriginal: false',
      '  registrarLacunas: false',
    ]);

    const result = await runCli(['validate', '--dir', dir], {});
    expect(result.stdout).not.toContain('unclassified_field');
    expect(result.exitCode).toBe(0);
  });

  it('recusa executionPolicy inválido com invalid_field_value', async () => {
    agente(['  executionPolicy: turbo']);

    const result = await runCli(['validate', '--dir', dir], {});
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('invalid_field_value');
    expect(result.stdout).toContain('definition.executionPolicy');
  });

  it('recusa alcance fora de SO_QUEM_FALA | PARCEIRO | OPERADOR com invalid_tool_binding', async () => {
    agente([], ['tools:', '  - tool: app_avaliacoes', '    alcance: TODOS']);

    const result = await runCli(['validate', '--dir', dir], {});
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('invalid_tool_binding');
    expect(result.stdout).toContain('tools[0].alcance');
  });
});

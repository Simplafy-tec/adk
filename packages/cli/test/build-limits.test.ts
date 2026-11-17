import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

// `limits` acima da classe `script` tem de ser recusado no `adk build` com o
// MESMO código que o apply do Hub devolve (`limits_over_budget`, path
// `definition.limits`). O build aprovava
// `{ cpu: 4, memory: 4096, timeout: 600 }` com `issues: []` e exit 0, mesmo com
// a política do Hub anunciando `limits.script = { cpu: 1, memory: 512, timeout: 60 }`.

const HUB = 'http://hub-limits-mock.test';

function politica(script: Record<string, number>): Record<string, unknown> {
  return {
    spec_versions: ['v1'],
    runtimes: { node: '>=20', python: ['3.12'], uv: '>=0.4' },
    limits: { script, mcp: {}, app: {}, org: {}, node: {} },
    registries: { allowed_images: [] },
    package: { max_size_bytes: 5_000_000 },
  };
}

const server = setupServer(
  http.get(`${HUB}/api/v1/adk/policy`, () =>
    HttpResponse.json(politica({ cpu: 1, memory: 512, timeout: 60 })),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function manifestoScript(limits: string): string {
  return [
    'spec_version: v1',
    'kind: tool',
    'slug: qa-hello',
    'definition:',
    '  name: qa_hello',
    '  description: Diz olá para quem chamar, com mais de vinte caracteres.',
    '  kind: native',
    '  input_schema:',
    '    type: object',
    '    properties: {}',
    '  runtime: script',
    '  python: "3.12"',
    '  entry: tools/qa_hello.py',
    '  handler: handler',
    `  limits: ${limits}`,
    '',
  ].join('\n');
}

interface Issue {
  code: string;
  path: string;
}

describe('adk build — limits da classe script', () => {
  let dir: string;

  function escreverManifesto(limits: string): void {
    writeFileSync(join(dir, 'manifest.yaml'), manifestoScript(limits));
  }

  async function build(
    env: Record<string, string>,
  ): Promise<{ exitCode: number; issues: Issue[] }> {
    const result = await runCli(['build'], { cwd: dir, env });
    return { exitCode: result.exitCode, issues: JSON.parse(result.stdout).issues as Issue[] };
  }

  const COM_HUB = { ADK_HUB_URL: HUB };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-build-limits-'));
    mkdirSync(join(dir, 'tools'));
    writeFileSync(
      join(dir, 'tools', 'qa_hello.py'),
      ['def handler(input):', '    return {"ok": True}', ''].join('\n'),
    );
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('recusa limits acima da classe com a política do Hub (cpu 4 / 4096 MB / 600 s), exit 1', async () => {
    escreverManifesto('{ cpu: 4, memory: 4096, timeout: 600 }');
    const { exitCode, issues } = await build(COM_HUB);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'limits_over_budget', path: 'definition.limits' }),
    );
    expect(exitCode).toBe(1);
  });

  it('recusa limits acima da classe também com a política embutida (Hub fora do ar)', async () => {
    // Hub fora do ar = erro de rede no endpoint da política. (Antes era
    // `ADK_HUB_URL: ''`, que hoje cai no perfil prod e falaria com produção.)
    server.use(http.get(`${HUB}/api/v1/adk/policy`, () => HttpResponse.error()));
    escreverManifesto('{ cpu: 4, memory: 4096, timeout: 600 }');
    const { exitCode, issues } = await build(COM_HUB);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'limits_over_budget', path: 'definition.limits' }),
    );
    expect(exitCode).toBe(1);
  });

  it('usa o teto anunciado pelo Hub, não só o embutido: memory 512 acima de um teto de 256 é recusado', async () => {
    server.use(
      http.get(`${HUB}/api/v1/adk/policy`, () =>
        HttpResponse.json(politica({ cpu: 1, memory: 256, timeout: 60 })),
      ),
    );
    escreverManifesto('{ cpu: 1, memory: 512, timeout: 60 }');
    const { issues } = await build(COM_HUB);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'limits_over_budget', path: 'definition.limits' }),
    );
  });

  it('recusa timeout 0, que no executor significa sem teto (paridade com o apply)', async () => {
    escreverManifesto('{ cpu: 1, memory: 512, timeout: 0 }');
    const { issues } = await build(COM_HUB);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'limits_over_budget', path: 'definition.limits' }),
    );
  });

  it('recusa chave de limits que a classe não conhece (paridade com o apply)', async () => {
    escreverManifesto('{ cpu: 1, memory: 512, timeout: 60, gpu: 1 }');
    const { issues } = await build(COM_HUB);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'limits_over_budget', path: 'definition.limits' }),
    );
  });

  it('aprova limits exatamente no teto da classe (exit 0, sem limits_over_budget)', async () => {
    escreverManifesto('{ cpu: 1, memory: 512, timeout: 60 }');
    const { exitCode, issues } = await build(COM_HUB);
    expect(issues.map((i) => i.code)).not.toContain('limits_over_budget');
    expect(exitCode).toBe(0);
  });
});

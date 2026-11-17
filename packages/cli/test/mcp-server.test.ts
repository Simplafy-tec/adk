import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

// `adk mcp-server` (stdio): list_components/get_contract/get_policy/validate/plan
// a um cliente MCP real — spawna o binário via tsx (o dev decide o entrypoint,
// aqui só se fixa o contrato: bin/adk.js mcp-server).

const binPath = fileURLToPath(new URL('../src/bin.ts', import.meta.url));

let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function conectar(envExtra: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', binPath, 'mcp-server'],
    env: { ...process.env, ...envExtra },
  });
  client = new Client({ name: 'adk-mcp-server-test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

describe('adk mcp-server', () => {
  it('lista as 5 tools: list_components, get_contract, get_policy, validate, plan', async () => {
    const c = await conectar();
    const { tools } = await c.listTools();
    const nomes = tools.map((t) => t.name).sort();
    expect(nomes).toEqual(['get_contract', 'get_policy', 'list_components', 'plan', 'validate'].sort());
  }, 20_000);

  it('validate({yaml}) devolve issues sem exigir login', async () => {
    const c = await conectar();
    const resultado = await c.callTool({
      name: 'validate',
      arguments: { yaml: 'kind: invented\n' },
    });
    const texto = JSON.stringify(resultado);
    expect(texto).toContain('unknown_kind');
  }, 20_000);

  it('plan sem login devolve um erro claro, nunca access_token', async () => {
    const c = await conectar();
    const resultado = await c.callTool({
      name: 'plan',
      arguments: { yaml: 'kind: tool\nspec_version: v1\nslug: x\n', org: 'org-1', env: 'staging' },
    });
    const texto = JSON.stringify(resultado);
    expect(texto.toLowerCase()).toMatch(/login|autentic/);
    expect(texto).not.toContain('access_token');
  }, 20_000);
});

// tool `plan` com `dir` e múltiplas orgs na mesma pasta: só os artefatos da
// org PEDIDA (via `org` + `env`, resolvidos por orgs/<pasta>/org.yaml) podem
// ir ao Hub — o mesmo isolamento que `comandoPlanOuDeploy` já aplica em
// `adk plan`. Hoje `plan` do mcp-server ignora `env` e manda TUDO sob `dir`.
describe('adk mcp-server — tool plan respeita a fronteira de organização sob --dir', () => {
  let hub: Server;
  let hubUrl: string;
  let recebidos: { orgId: string | null; org: string; slug: string }[];
  let dir: string;

  beforeAll(async () => {
    hub = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/api/v1/adk/tools/plan' && req.method === 'POST') {
        let corpo = '';
        req.on('data', (c) => (corpo += c));
        req.on('end', () => {
          const { yaml } = JSON.parse(corpo) as { yaml: string };
          const org = yaml.match(/^org-dono:\s*(\S+)/m)?.[1] ?? '';
          const slug = yaml.match(/^slug:\s*(\S+)/m)?.[1] ?? '';
          recebidos.push({ orgId: url.searchParams.get('orgId'), org, slug });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ plan: { action: 'noop', blocking: [] } }));
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
    const { port } = hub.address() as AddressInfo;
    hubUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => new Promise<void>((resolve) => hub.close(() => resolve())));

  beforeEach(() => {
    recebidos = [];
    dir = mkdtempSync(join(tmpdir(), 'adk-mcp-plan-'));
    for (const [pasta, orgId] of [
      ['org-a', 'org-a-staging'],
      ['org-b', 'org-b-staging'],
    ] as const) {
      mkdirSync(join(dir, 'orgs', pasta, 'tools'), { recursive: true });
      writeFileSync(
        join(dir, 'orgs', pasta, 'org.yaml'),
        ['environments:', `  staging: ${orgId}`].join('\n'),
      );
      writeFileSync(
        join(dir, 'orgs', pasta, 'tools', `tool-${pasta}.yaml`),
        [
          'spec_version: v1',
          'kind: tool',
          `slug: tool-${pasta}`,
          `org-dono: ${pasta}`,
          'definition:',
          `  name: tool_${pasta}`,
        ].join('\n'),
      );
    }
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('planeja só os artefatos da org pedida, não os de outra org na mesma pasta', async () => {
    const c = await conectar({ ADK_HUB_URL: hubUrl, ADK_TOKEN: 'fake-token' });
    await c.callTool({
      name: 'plan',
      arguments: { dir, org: 'org-a-staging', env: 'staging' },
    });
    expect(recebidos).toHaveLength(1);
    expect(recebidos[0]?.org).toBe('org-a');
    expect(recebidos.some((r) => r.org === 'org-b')).toBe(false);
  }, 20_000);
});

// issue#2769 — `list_components` anuncia seis kinds e `get_contract` só conhecia
// três: os outros três respondiam `kind desconhecido`, que é a resposta de um
// kind que NÃO EXISTE. Eles existem; o que não existe é schema público deles.
describe('adk mcp-server — get_contract dos kinds julgados pelo servidor', () => {
  for (const [kind, campo] of [
    ['mcp', 'image'],
    ['app', 'icon'],
    ['table', 'app'],
  ] as const) {
    it(`get_contract(${kind}) responde os campos que o apply exige, não um erro`, async () => {
      const c = await conectar();
      const resultado = (await c.callTool({ name: 'get_contract', arguments: { kind } })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(resultado.isError ?? false).toBe(false);
      const corpo = JSON.parse(resultado.content[0]!.text) as {
        contrato?: string;
        campos_obrigatorios?: { campo: string }[];
      };
      expect(corpo.contrato).toBe('parcial');
      expect(corpo.campos_obrigatorios?.map((c2) => c2.campo)).toContain(campo);
      expect(JSON.stringify(corpo)).not.toContain('desconhecido');
    }, 20_000);
  }


  it('get_contract(agent) inclui tools no JSON Schema com forma ToolBindingSpec', async () => {
    const c = await conectar();
    const resultado = (await c.callTool({ name: 'get_contract', arguments: { kind: 'agent' } })) as {
      content: { text: string }[];
    };
    const corpo = JSON.parse(resultado.content[0]!.text) as Record<string, unknown>;
    const defs = corpo.definitions as Record<string, unknown> | undefined;

    function variantesDoSchema(no: unknown): { properties?: Record<string, unknown> }[] {
      if (!no || typeof no !== 'object') return [];
      const obj = no as Record<string, unknown>;
      if (typeof obj.$ref === 'string' && defs) {
        const nome = obj.$ref.replace('#/definitions/', '');
        return variantesDoSchema(defs[nome]);
      }
      const ramos = [...((obj.oneOf as unknown[]) ?? []), ...((obj.anyOf as unknown[]) ?? [])];
      if (ramos.length > 0) return ramos.flatMap((r) => variantesDoSchema(r));
      if (obj.properties) return [obj as { properties?: Record<string, unknown> }];
      return [];
    }

    const agent = (defs?.agent ?? corpo) as { properties?: Record<string, unknown> };
    const tools = agent.properties?.tools as { type?: string; items?: unknown } | undefined;
    expect(tools?.type).toBe('array');
    const variantes = variantesDoSchema(tools?.items);
    expect(variantes.length).toBeGreaterThan(0);

    const campos = new Set<string>();
    for (const v of variantes) {
      for (const k of Object.keys(v.properties ?? {})) campos.add(k);
    }
    for (const campo of [
      'tool',
      'integration',
      'connection',
      'enabled',
      'mcp_tool_names',
      'allowed_actions',
    ]) {
      expect(campos.has(campo)).toBe(true);
    }
    for (const v of variantes) {
      const props = v.properties ?? {};
      expect(!(props.tool && props.integration)).toBe(true);
    }
  }, 20_000);

  it('get_contract(tool) continua devolvendo o JSON Schema completo', async () => {
    const c = await conectar();
    const resultado = (await c.callTool({ name: 'get_contract', arguments: { kind: 'tool' } })) as {
      content: { text: string }[];
    };
    const corpo = JSON.parse(resultado.content[0]!.text) as Record<string, unknown>;
    expect(corpo.$schema ?? corpo.definitions ?? corpo.type).toBeDefined();
    expect(corpo.contrato).toBeUndefined();
  }, 20_000);
});

// issue#2767 — a rota `plan` responde o plano CRU (sem envelope `plan`); só o
// `apply` responde `{plan, applied}`. Lendo `r.plan` a tool devolvia `null`
// sempre, e o agente concluía "nada a mudar" sem nunca ter visto o diff.
describe('adk mcp-server — tool plan devolve o plano quando a rota responde cru', () => {
  let hub: Server;
  let hubUrl: string;
  let dir: string;
  // Exatamente o que a API responde no `plan`: o plano no TOPO, sem envelope.
  let respostaDoHub: unknown = {
    slug: 'tool-org-a',
    action: 'update',
    changes: [{ field: 'temperature', from: 0.3, to: 0.7 }],
    drift: { drifted: false },
  };

  beforeAll(async () => {
    hub = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/api/v1/adk/tools/plan' && req.method === 'POST') {
        req.on('data', () => {});
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(respostaDoHub));
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
    const { port } = hub.address() as AddressInfo;
    hubUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => new Promise<void>((resolve) => hub.close(() => resolve())));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-mcp-plan-cru-'));
    mkdirSync(join(dir, 'orgs', 'org-a', 'tools'), { recursive: true });
    writeFileSync(
      join(dir, 'orgs', 'org-a', 'org.yaml'),
      ['environments:', '  staging: org-a-staging'].join('\n'),
    );
    writeFileSync(
      join(dir, 'orgs', 'org-a', 'tools', 'tool-org-a.yaml'),
      [
        'spec_version: v1',
        'kind: tool',
        'slug: tool-org-a',
        'definition:',
        '  name: tool_org_a',
      ].join('\n'),
    );
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a tool plan mostra as mudanças do plano cru', async () => {
    const c = await conectar({ ADK_HUB_URL: hubUrl, ADK_TOKEN: 'fake-token' });
    const resultado = (await c.callTool({
      name: 'plan',
      arguments: { dir, org: 'org-a-staging', env: 'staging' },
    })) as { content: { text: string }[] };
    const { planos } = JSON.parse(resultado.content[0]!.text) as {
      planos: { arquivo: string; plan?: { action?: string; changes?: unknown[] } }[];
    };
    expect(planos).toHaveLength(1);
    expect(planos[0]?.plan?.action).toBe('update');
    expect(planos[0]?.plan?.changes).toHaveLength(1);
  }, 20_000);

  // A outra metade do valor: um artefato convergido tem de dizer `noop`, não
  // `null`. Sem esta asserção, "nada a mudar" e "não sei" voltariam a ser
  // indistinguíveis se a rota um dia respondesse envelope vazio.
  it('artefato convergido chega como noop, não como null', async () => {
    respostaDoHub = { slug: 'tool-org-a', action: 'noop', changes: [], drift: { drifted: false } };
    const c = await conectar({ ADK_HUB_URL: hubUrl, ADK_TOKEN: 'fake-token' });
    const resultado = (await c.callTool({
      name: 'plan',
      arguments: { dir, org: 'org-a-staging', env: 'staging' },
    })) as { content: { text: string }[] };
    const { planos } = JSON.parse(resultado.content[0]!.text) as {
      planos: { plan?: { action?: string; changes?: unknown[] } | null }[];
    };
    expect(planos[0]?.plan).not.toBeNull();
    expect(planos[0]?.plan?.action).toBe('noop');
    expect(planos[0]?.plan?.changes).toEqual([]);
  }, 20_000);
});

// docs/adk-externo (ticket 01) — a tool `plan` sob `dir` escolhe a pasta pelo
// ambiente, e o ambiente vem do perfil, como no `adk plan`. A org `acme`
// declara SÓ staging: com o ambiente errado, nenhuma pasta é escolhida e nada
// vai ao Hub — é o que torna a derivação observável sem falar com produção.
describe('adk mcp-server — tool plan deriva o ambiente do perfil', () => {
  let hub: Server;
  let hubUrl: string;
  let recebidos: string[];
  let dir: string;
  const ORG_STG = 'acme-staging';

  beforeAll(async () => {
    hub = createServer((req, res) => {
      if (req.method === 'POST' && (req.url ?? '').startsWith('/api/v1/adk/tools/plan')) {
        recebidos.push(req.url ?? '');
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ action: 'noop', changes: [] }));
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
    hubUrl = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => hub.close(() => resolve())));

  beforeEach(() => {
    recebidos = [];
    dir = mkdtempSync(join(tmpdir(), 'adk-mcp-perfil-'));
    mkdirSync(join(dir, 'orgs', 'acme', 'tools'), { recursive: true });
    writeFileSync(join(dir, 'orgs', 'acme', 'org.yaml'), `environments:\n  staging: ${ORG_STG}\n`);
    writeFileSync(
      join(dir, 'orgs', 'acme', 'tools', 'tool-a.yaml'),
      ['spec_version: v1', 'kind: tool', 'slug: tool-a', 'definition:', '  name: tool_a'].join('\n'),
    );
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function planSemEnv(env: Record<string, string>) {
    const c = await conectar(env);
    return (await c.callTool({ name: 'plan', arguments: { dir, org: ORG_STG } })) as {
      isError?: boolean;
      content: { text: string }[];
    };
  }

  it('com ADK_PROFILE=staging e sem env, planeja a pasta de staging', async () => {
    const r = await planSemEnv({ ADK_PROFILE: 'staging', ADK_HUB_URL: hubUrl, ADK_TOKEN: 'fake-token' });

    expect(recebidos).toEqual([`/api/v1/adk/tools/plan?orgId=${ORG_STG}`]);
    expect(r.isError ?? false).toBe(false);
  }, 20_000);

  it('sem perfil e sem URL, o ambiente é production: a pasta só de staging não é planejada', async () => {
    // Nenhuma chamada sai: se saísse, iria ao Hub de produção e a guarda de
    // rede da suíte reprovaria o teste.
    const r = await planSemEnv({ ADK_TOKEN: 'fake-token' });

    const corpo = JSON.parse(r.content[0]!.text) as { planos?: unknown[] };
    expect(corpo.planos).toEqual([]);
  }, 20_000);

  it('com ADK_HUB_URL desconhecido, sem perfil e sem env, recusa pedindo o env e nada vai ao Hub', async () => {
    // Mesma regra do `adk plan`: o host não diz o ambiente, então não há
    // padrão silencioso (a tool caía em staging).
    const r = await planSemEnv({ ADK_HUB_URL: hubUrl, ADK_TOKEN: 'fake-token' });

    expect(recebidos).toEqual([]);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/env/);
  }, 20_000);

  it('perfil staging com env production divergente recusa e nada vai ao Hub', async () => {
    const c = await conectar({ ADK_PROFILE: 'staging', ADK_HUB_URL: hubUrl, ADK_TOKEN: 'fake-token' });
    const r = (await c.callTool({
      name: 'plan',
      arguments: { dir, org: ORG_STG, env: 'production' },
    })) as { isError?: boolean; content: { text: string }[] };

    expect(recebidos).toEqual([]);
    expect(r.isError).toBe(true);
  }, 20_000);
});

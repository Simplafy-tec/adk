import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HEADERS_JSON_RPC,
  chamarTool,
  corpoToolsList,
  envSemToken,
  esperarHealth200,
  escutaEmTodasAsInterfaces,
  enderecosEmEscuta,
  gerarSatelite,
  listarTools,
  portaLivre,
  subir,
  type ProcessoVivo,
} from './satelite-processo.js';

// Hub#2.6.26.4 — o servidor MCP gerado por `adk init mcp --runtime node`,
// exercitado como PROCESSO REAL pelo mesmo `npm run dev` que o `adk dev`
// dispara. Nenhuma edição no que o `init` gerou.
//
// Fail-closed por desenho: a issue#2670 foi exatamente um satélite
// respondendo `tools/list`/`tools/call` ANÔNIMO pela ingress pública.
//
// Nome da env do token: `MCP_TOKEN` — o nome que o satélite de referência já
// usa em produção e que o esqueleto Python também lê.
//
// Os processos são caros (≈1–3 s para subir): um por cenário de credencial,
// compartilhado pelos casos do bloco.

const TOKEN = 'token-secreto-de-verdade';
const PRAZO_SUBIDA_MS = 30_000;

async function subirSatelite(
  alvo: string,
  env: Record<string, string | undefined>,
): Promise<{ vivo: ProcessoVivo; porta: number }> {
  const porta = await portaLivre();
  const vivo = subir('npm', ['run', 'dev'], { cwd: alvo, env: envSemToken({ ...env, PORT: String(porta) }) });
  const subiu = await esperarHealth200(porta, PRAZO_SUBIDA_MS);
  if (!subiu) {
    await vivo.encerrar();
    throw new Error(`o satélite não respondeu /health 200 na porta ${porta}. Saída:\n${vivo.saida()}`);
  }
  return { vivo, porta };
}

describe('servidor MCP gerado (runtime node) — sobe sem edição e responde', () => {
  let dir: string;
  let vivo: ProcessoVivo | undefined;
  let porta: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'adk-mcp-node-server-'));
    const alvo = await gerarSatelite(dir, 'node');
    ({ vivo, porta } = await subirSatelite(alvo, { MCP_TOKEN: TOKEN }));
  }, 60_000);

  afterAll(async () => {
    await vivo?.encerrar();
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  it('a porta está ESCUTANDO em todas as interfaces (bind 0.0.0.0 explícito), sem BIND_ADDRESS no ambiente', () => {
    // Loopback aqui é o defeito do 1º satélite: o pod sobe, a probe do
    // kubelet (que chega pelo IP do pod) falha e o rollout morre calado.
    expect(enderecosEmEscuta(porta).length).toBeGreaterThan(0);
    expect(escutaEmTodasAsInterfaces(porta)).toBe(true);
  });

  it('GET /health ⇒ 200 sem exigir Bearer (readiness e liveness do chart apontam para lá)', async () => {
    const res = await fetch(`http://127.0.0.1:${porta}/health`);
    expect(res.status).toBe(200);
  });

  it('tools/list por um cliente MCP real (Streamable HTTP) com Bearer correto lista a tool de exemplo `ping`', async () => {
    const tools = await listarTools(porta, TOKEN);
    expect(tools).toContain('ping');
  });

  it('tools/call da tool de exemplo `ping` devolve `pong` (o caminho da chamada, não só o registro)', async () => {
    expect(await chamarTool(porta, TOKEN, 'ping')).toContain('pong');
  });

  it('anônimo (sem Authorization) ⇒ 401 com WWW-Authenticate: Bearer, nunca 200 nem 500', async () => {
    const res = await fetch(`http://127.0.0.1:${porta}/mcp`, {
      method: 'POST',
      headers: HEADERS_JSON_RPC,
      body: corpoToolsList(),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/Bearer/i);
  });

  it('Bearer errado ⇒ 401 (nunca 500)', async () => {
    const res = await fetch(`http://127.0.0.1:${porta}/mcp`, {
      method: 'POST',
      headers: { ...HEADERS_JSON_RPC, Authorization: 'Bearer errado-errado-errado' },
      body: corpoToolsList(),
    });
    expect(res.status).toBe(401);
  });

  it('cliente MCP real com Bearer errado não consegue listar tools', async () => {
    await expect(listarTools(porta, 'errado-errado-errado')).rejects.toThrow();
  });

  it('401 sem Bearer e 401 com Bearer errado têm corpo IDÊNTICO byte a byte (sem oráculo de credencial)', async () => {
    const semBearer = await fetch(`http://127.0.0.1:${porta}/mcp`, {
      method: 'POST',
      headers: HEADERS_JSON_RPC,
      body: corpoToolsList(),
    });
    const comBearerErrado = await fetch(`http://127.0.0.1:${porta}/mcp`, {
      method: 'POST',
      headers: { ...HEADERS_JSON_RPC, Authorization: 'Bearer bearer-completamente-errado' },
      body: corpoToolsList(),
    });
    expect(semBearer.status).toBe(401);
    expect(comBearerErrado.status).toBe(401);
    expect(await semBearer.text()).toBe(await comBearerErrado.text());
  });

  it.each([
    ['Authorization Basic (esquema errado)', 'Basic abc'],
    ['Bearer sem valor', 'Bearer'],
    ['o token sem o esquema Bearer', TOKEN],
    ['Bearer com um caractere a menos', `Bearer ${TOKEN.slice(0, -1)}`],
    ['Bearer com um caractere a mais', `Bearer ${TOKEN}x`],
    // Mesmo tamanho e mesmo prefixo: só a comparação do conteúdo inteiro
    // (em tempo constante) recusa. Mata o mutante que compara só tamanho/prefixo.
    ['Bearer errado do MESMO tamanho (difere só no último caractere)', `Bearer ${TOKEN.slice(0, -1)}X`],
    ['Bearer errado do MESMO tamanho (todo diferente)', `Bearer ${'x'.repeat(TOKEN.length)}`],
  ])('%s ⇒ 401', async (_rotulo, valor) => {
    const res = await fetch(`http://127.0.0.1:${porta}/mcp`, {
      method: 'POST',
      headers: { ...HEADERS_JSON_RPC, Authorization: valor },
      body: corpoToolsList(),
    });
    expect(res.status).toBe(401);
  });

  it('corpo e headers do 401 não revelam o token', async () => {
    const res = await fetch(`http://127.0.0.1:${porta}/mcp`, {
      method: 'POST',
      headers: { ...HEADERS_JSON_RPC, Authorization: 'Bearer bearer-errado' },
      body: corpoToolsList(),
    });
    expect(await res.text()).not.toContain(TOKEN);
    expect(JSON.stringify([...res.headers.entries()])).not.toContain(TOKEN);
  });
});

describe.each([
  ['ausente', undefined],
  ['vazio', ''],
  ['só espaços', '   '],
])('servidor MCP gerado (runtime node) — MCP_TOKEN %s: fail-closed, nunca aberto', (_rotulo, token) => {
  let dir: string;
  let vivo: ProcessoVivo | undefined;
  let porta: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'adk-mcp-node-sem-token-'));
    const alvo = await gerarSatelite(dir, 'node');
    ({ vivo, porta } = await subirSatelite(alvo, { MCP_TOKEN: token }));
  }, 60_000);

  afterAll(async () => {
    await vivo?.encerrar();
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  it('o processo SOBE e /health responde 200 (NUNCA 503: o chart aponta readiness E liveness para /health)', async () => {
    const res = await fetch(`http://127.0.0.1:${porta}/health`);
    expect(res.status).toBe(200);
    // O estado da credencial vai no CORPO, nunca no status — a causa fica
    // legível sem derrubar a probe.
    expect((await res.text()).toLowerCase()).toMatch(/token|credencial|config/);
  });

  it('POST /mcp anônimo ⇒ 503', async () => {
    const res = await fetch(`http://127.0.0.1:${porta}/mcp`, {
      method: 'POST',
      headers: HEADERS_JSON_RPC,
      body: corpoToolsList(),
    });
    expect(res.status).toBe(503);
  });

  it('POST /mcp com qualquer Bearer — inclusive vazio — ⇒ 503: token esperado vazio × Bearer vazio não "confere"', async () => {
    for (const valor of ['Bearer qualquer-coisa', 'Bearer ', 'Bearer']) {
      const res = await fetch(`http://127.0.0.1:${porta}/mcp`, {
        method: 'POST',
        headers: { ...HEADERS_JSON_RPC, Authorization: valor },
        body: corpoToolsList(),
      });
      expect(res.status).toBe(503);
    }
  });

  it('cliente MCP real não consegue listar tools', async () => {
    await expect(listarTools(porta, '')).rejects.toThrow();
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HEADERS_JSON_RPC,
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

// Dev note da Hub#2.6.26.4 — os defeitos do 1º satélite real valem para os
// DOIS runtimes: `mcp.run()` sem argumento é stdio, e o host default do
// FastMCP é 127.0.0.1. O esqueleto Python (`adk init mcp`, sem `--runtime`)
// tem de nascer com transporte HTTP explícito, bind 0.0.0.0 e `/health` — e a
// prova é o processo de pé, pelo MESMO comando que o `adk dev` dispara
// (`uv run python server.py`), sem nenhuma edição no que o `init` gerou.
//
// Precisa de `uv` no host (o CI instala com `astral-sh/setup-uv`). O primeiro
// `uv run` resolve e instala `mcp`/`uvicorn`: daí o prazo de subida maior.

const TOKEN = 'token-do-satelite-python';
const PRAZO_SUBIDA_MS = 90_000;

async function subirSatelite(
  alvo: string,
  env: Record<string, string | undefined>,
): Promise<{ vivo: ProcessoVivo; porta: number }> {
  const porta = await portaLivre();
  const vivo = subir('uv', ['run', 'python', 'server.py'], {
    cwd: alvo,
    env: envSemToken({ ...env, PORT: String(porta) }),
  });
  const subiu = await esperarHealth200(porta, PRAZO_SUBIDA_MS);
  if (!subiu) {
    await vivo.encerrar();
    throw new Error(`o satélite Python não respondeu /health 200 na porta ${porta}. Saída:\n${vivo.saida()}`);
  }
  return { vivo, porta };
}

describe('servidor MCP gerado (runtime python) — processo real, sem BIND_ADDRESS', () => {
  let dir: string;
  let vivo: ProcessoVivo | undefined;
  let porta: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'adk-mcp-py-server-'));
    const alvo = await gerarSatelite(dir, 'python');
    ({ vivo, porta } = await subirSatelite(alvo, { MCP_TOKEN: TOKEN }));
  }, 120_000);

  afterAll(async () => {
    await vivo?.encerrar();
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  it('a porta está ESCUTANDO em todas as interfaces (bind 0.0.0.0 explícito), não só no loopback', () => {
    expect(enderecosEmEscuta(porta).length).toBeGreaterThan(0);
    expect(escutaEmTodasAsInterfaces(porta)).toBe(true);
  });

  it('GET /health ⇒ 200 sem Bearer', async () => {
    const res = await fetch(`http://127.0.0.1:${porta}/health`);
    expect(res.status).toBe(200);
  });

  it('transporte HTTP: um cliente MCP real (Streamable HTTP) com Bearer lista a tool `ping`', async () => {
    expect(await listarTools(porta, TOKEN)).toContain('ping');
  });

  it.each([
    ['difere só no último caractere', `${TOKEN.slice(0, -1)}X`],
    ['todo diferente', 'x'.repeat(TOKEN.length)],
  ])('Bearer errado do MESMO tamanho do token (%s) ⇒ 401', async (_rotulo, errado) => {
    expect(errado).toHaveLength(TOKEN.length);
    const res = await fetch(`http://127.0.0.1:${porta}/mcp`, {
      method: 'POST',
      headers: { ...HEADERS_JSON_RPC, Authorization: `Bearer ${errado}` },
      body: corpoToolsList(),
    });
    expect(res.status).toBe(401);
  });

  it('anônimo ⇒ 401 com WWW-Authenticate: Bearer', async () => {
    const res = await fetch(`http://127.0.0.1:${porta}/mcp`, {
      method: 'POST',
      headers: HEADERS_JSON_RPC,
      body: corpoToolsList(),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/Bearer/i);
  });
});

describe('servidor MCP gerado (runtime python) — sem MCP_TOKEN', () => {
  let dir: string;
  let vivo: ProcessoVivo | undefined;
  let porta: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'adk-mcp-py-sem-token-'));
    const alvo = await gerarSatelite(dir, 'python');
    ({ vivo, porta } = await subirSatelite(alvo, { MCP_TOKEN: undefined }));
  }, 120_000);

  afterAll(async () => {
    await vivo?.encerrar();
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  it('sobe, /health responde 200 e POST /mcp com Bearer responde 503 — nunca aberto', async () => {
    expect((await fetch(`http://127.0.0.1:${porta}/health`)).status).toBe(200);
    const res = await fetch(`http://127.0.0.1:${porta}/mcp`, {
      method: 'POST',
      headers: { ...HEADERS_JSON_RPC, Authorization: 'Bearer qualquer-coisa' },
      body: corpoToolsList(),
    });
    expect(res.status).toBe(503);
  });
});

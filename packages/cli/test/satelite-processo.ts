/**
 * Helpers dos testes que sobem o satélite MCP como PROCESSO REAL.
 *
 * Dev note da Hub#2.6.26.4 — os defeitos do 1º satélite real só apareceram
 * com o processo de pé: `mcp.run()` sem argumento caía em stdio, e o host
 * default do FastMCP era loopback. O pod subia, a probe falhava e o log não
 * dizia nada. Por isso estes testes não aceitam "o processo subiu" como
 * prova: a porta tem de estar ESCUTANDO em todas as interfaces e `/health`
 * tem de responder 200.
 *
 * Determinismo: porta livre pedida ao SO (nunca fixa), espera por sentinela
 * (o `/health` respondendo) com prazo explícito, e o GRUPO de processos é
 * morto no fim — `npm run dev` e `uv run` deixam netos que seguram a porta.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { runCli } from '../src/cli.js';

/** Raiz do monorepo — o `node_modules` dela já tem o SDK MCP e o `tsx`. */
export const RAIZ_MONOREPO = fileURLToPath(new URL('../../..', import.meta.url));

/** Binário da CLI construído pelo `vitest.global-setup.ts`. */
export const BIN_CLI = join(RAIZ_MONOREPO, 'packages', 'cli', 'dist', 'bin.js');

export async function portaLivre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

/**
 * Gera o satélite com `adk init mcp [--runtime node]`.
 *
 * No runtime node, o `node_modules` do componente é EMPRESTADO da raiz do
 * monorepo: o `npm install` de um componente publicado é do autor, não deste
 * harness (e a suíte não fala com a rede).
 */
export async function gerarSatelite(
  dir: string,
  runtime: 'python' | 'node',
  nome = `satelite-${runtime}`,
): Promise<string> {
  const alvo = join(dir, nome);
  const argv = ['init', 'mcp', ...(runtime === 'node' ? ['--runtime', 'node'] : []), nome, '--dir', alvo];
  const result = await runCli(argv, { cwd: dir });
  if (result.exitCode !== 0) {
    throw new Error(`adk init falhou (exit ${result.exitCode}): ${result.stderr}${result.stdout}`);
  }
  if (runtime === 'node') symlinkSync(join(RAIZ_MONOREPO, 'node_modules'), join(alvo, 'node_modules'));
  return alvo;
}

export interface ProcessoVivo {
  processo: ChildProcess;
  saida: () => string;
  encerrar: () => Promise<void>;
}

/** Sobe `comando args` como líder de grupo, acumulando stdout+stderr. */
export function subir(
  comando: string,
  args: string[],
  opcoes: { cwd: string; env: NodeJS.ProcessEnv },
): ProcessoVivo {
  const processo = spawn(comando, args, {
    cwd: opcoes.cwd,
    env: opcoes.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let saida = '';
  processo.stdout?.on('data', (c) => (saida += String(c)));
  processo.stderr?.on('data', (c) => (saida += String(c)));
  return { processo, saida: () => saida, encerrar: () => encerrarArvore(processo.pid) };
}

export function processoVivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** PID → PPID de todo processo visível em `/proc` (Linux). */
function tabelaDePais(): Map<number, number> {
  const pais = new Map<number, number>();
  let entradas: string[] = [];
  try {
    entradas = readdirSync('/proc');
  } catch {
    return pais;
  }
  for (const nome of entradas) {
    if (!/^\d+$/.test(nome)) continue;
    try {
      const stat = readFileSync(`/proc/${nome}/stat`, 'utf8');
      // O campo 2 (comm) pode ter espaço e parêntese: o PPID vem depois do último ')'.
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      pais.set(Number(nome), ppid);
    } catch {
      // o processo saiu entre o readdir e a leitura
    }
  }
  return pais;
}

/** O PID e TODOS os descendentes dele, inclusive os que mudaram de grupo (`detached`). */
export function arvoreDe(pid: number): number[] {
  const pais = tabelaDePais();
  const arvore = [pid];
  for (let i = 0; i < arvore.length; i++) {
    for (const [filho, pai] of pais) if (pai === arvore[i] && !arvore.includes(filho)) arvore.push(filho);
  }
  return arvore;
}

function sinalizar(pid: number, sinal: NodeJS.Signals): void {
  for (const alvo of [-pid, pid]) {
    try {
      process.kill(alvo, sinal);
    } catch {
      // grupo/processo já não existe
    }
  }
}

/**
 * Encerra a ÁRVORE inteira, não só o grupo do processo lançado: o satélite que
 * o `adk dev` sobe é `detached` (outro grupo), e matar só o grupo do `adk dev`
 * deixava o satélite órfão segurando a porta. A árvore é fotografada ANTES do
 * primeiro sinal — depois, o neto órfão é adotado pelo init e some dela.
 */
export async function encerrarArvore(pid: number | undefined): Promise<void> {
  if (typeof pid !== 'number') return;
  const arvore = arvoreDe(pid);
  for (const p of arvore) sinalizar(p, 'SIGTERM');
  const fim = Date.now() + 5_000;
  while (Date.now() < fim && arvore.some(processoVivo)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  for (const p of arvore) if (processoVivo(p)) sinalizar(p, 'SIGKILL');
}

export async function ate(condicao: () => boolean | Promise<boolean>, prazoMs: number): Promise<boolean> {
  const fim = Date.now() + prazoMs;
  while (Date.now() < fim) {
    if (await condicao()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return condicao();
}

export async function statusHealth(porta: number): Promise<number | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${porta}/health`, { signal: AbortSignal.timeout(1_000) });
    await res.arrayBuffer();
    return res.status;
  } catch {
    return undefined;
  }
}

/** Espera o `/health` responder 200; devolve false se o prazo vencer. */
export function esperarHealth200(porta: number, prazoMs: number): Promise<boolean> {
  return ate(async () => (await statusHealth(porta)) === 200, prazoMs);
}

/**
 * Endereços locais em que há um socket em LISTEN na porta, lidos do kernel
 * (`/proc/net/tcp` e `tcp6`). `0.0.0.0` aparece como `00000000`; `::` como
 * 32 zeros. Não usa a rede: lê só a tabela de sockets.
 */
export function enderecosEmEscuta(porta: number): string[] {
  const hexPorta = porta.toString(16).toUpperCase().padStart(4, '0');
  const enderecos: string[] = [];
  for (const arquivo of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let texto = '';
    try {
      texto = readFileSync(arquivo, 'utf8');
    } catch {
      continue;
    }
    for (const linha of texto.split('\n').slice(1)) {
      const campos = linha.trim().split(/\s+/);
      const [endereco, portaHex] = (campos[1] ?? '').split(':');
      if (portaHex === hexPorta && campos[3] === '0A') enderecos.push(endereco ?? '');
    }
  }
  return enderecos;
}

/** `true` quando o socket em LISTEN aceita qualquer interface (0.0.0.0 ou ::). */
export function escutaEmTodasAsInterfaces(porta: number): boolean {
  return enderecosEmEscuta(porta).some((e) => /^0+$/.test(e));
}

/** `tools/list` por um cliente MCP de verdade (Streamable HTTP), com Bearer. */
export async function listarTools(porta: number, token: string): Promise<string[]> {
  const cliente = new Client({ name: 'teste-adk', version: '0.0.0' });
  const transporte = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${porta}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await cliente.connect(transporte);
  try {
    const { tools } = await cliente.listTools();
    return tools.map((t) => t.name);
  } finally {
    await cliente.close();
  }
}

/** `tools/call` por um cliente MCP de verdade, devolvendo o texto do resultado. */
export async function chamarTool(porta: number, token: string, nome: string): Promise<string> {
  const cliente = new Client({ name: 'teste-adk', version: '0.0.0' });
  const transporte = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${porta}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await cliente.connect(transporte);
  try {
    const r = (await cliente.callTool({ name: nome, arguments: {} })) as {
      content?: { type: string; text?: string }[];
    };
    return (r.content ?? []).map((c) => c.text ?? '').join('');
  } finally {
    await cliente.close();
  }
}

export const HEADERS_JSON_RPC = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

export function corpoToolsList(): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
}

/** Ambiente do processo filho sem o token herdado do worker. */
export function envSemToken(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.MCP_TOKEN;
  delete env.BIND_ADDRESS;
  delete env.PORT;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

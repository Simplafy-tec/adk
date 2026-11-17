import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { comandoDev } from '../src/commands/dev.js';
import { ARQUIVO_SERVIDOR, comandoServidorMcp, supervisor } from '../src/commands/dev-mcp.js';
import type { Ctx } from '../src/ctx.js';

// issue#2764 — `adk dev` de `kind: mcp` caía no ramo de `tool`, que faz
// `sorted(glob.glob('tools/*.py'))[0]`. O `adk init mcp` gera `server.py` na
// raiz e nenhum `tools/`: o glob vinha vazio e a CLI morria com
// `IndexError: list index out of range`. Não havia teste de `adk dev` com
// `kind: mcp` — é por isso que o caso nunca foi exercitado.

function ctxDeTeste(cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx = {
    cwd,
    env,
    out: (linha: string) => out.push(linha),
    err: (linha: string) => err.push(linha),
  } as unknown as Ctx;
  return { ctx, out, err };
}

const MANIFESTO_MCP = [
  'spec_version: v1',
  'kind: mcp',
  'slug: demo-plugin-mcp',
  'name: Demo plugin MCP',
  '',
].join('\n');

async function esperarArquivo(caminho: string, tentativas = 40): Promise<string> {
  for (let i = 0; i < tentativas; i++) {
    if (existsSync(caminho)) return readFileSync(caminho, 'utf8');
    await new Promise((r) => setTimeout(r, 50));
  }
  return '';
}

describe('adk dev — kind: mcp', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-dev-mcp-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('o comando do ciclo é o servidor, não o handler de tool', () => {
    expect(comandoServidorMcp()).toEqual({ comando: 'uv', args: ['run', 'python', 'server.py'] });
  });

  it('sem server.py, falha com mensagem acionável — não com traceback de Python', async () => {
    writeFileSync(join(dir, 'manifest.yaml'), MANIFESTO_MCP);
    const { ctx, err } = ctxDeTeste(dir);
    const codigo = await comandoDev(ctx, { dir });
    expect(codigo).toBe(2);
    expect(err.join('\n')).toContain(ARQUIVO_SERVIDOR);
    expect(err.join('\n')).not.toContain('IndexError');
  });

  it('sobe o servidor e o reinicia a cada save', async () => {
    writeFileSync(join(dir, 'manifest.yaml'), MANIFESTO_MCP);
    writeFileSync(join(dir, ARQUIVO_SERVIDOR), 'print("servidor")\n');

    // `uv` falso no PATH: registra a chamada e sai. Prova o comando REAL que a
    // CLI dispara, sem depender de um servidor MCP de verdade no teste.
    const bin = mkdtempSync(join(tmpdir(), 'adk-bin-'));
    const uv = join(bin, 'uv');
    writeFileSync(uv, '#!/bin/sh\necho "$@" >> chamadas.log\n');
    chmodSync(uv, 0o755);

    const { ctx } = ctxDeTeste(dir, { PATH: bin });
    const servidor = supervisor(ctx, dir);
    try {
      expect(await esperarArquivo(join(dir, 'chamadas.log'))).toContain('run python server.py');
      servidor.reiniciar();
      for (let i = 0; i < 40; i++) {
        const linhas = readFileSync(join(dir, 'chamadas.log'), 'utf8').trim().split('\n');
        if (linhas.length >= 2) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const linhas = readFileSync(join(dir, 'chamadas.log'), 'utf8').trim().split('\n');
      expect(linhas.length).toBeGreaterThanOrEqual(2);
    } finally {
      servidor.encerrar();
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('MCP_TOKEN do operador chega ao servidor Python (sem ele o esqueleto responde 503); ADK_TOKEN não', async () => {
    // O `server.py` gerado lê `os.environ["MCP_TOKEN"]` e, sem ele, responde
    // 503 em `/mcp` — o autor não exercita nem o próprio `tools/list` em dev.
    // A fonte é o ambiente do operador (`MCP_TOKEN=dev adk dev`, skill
    // adk-dev), o mesmo contrato do satélite Node.
    writeFileSync(join(dir, 'manifest.yaml'), MANIFESTO_MCP);
    writeFileSync(join(dir, ARQUIVO_SERVIDOR), 'print("servidor")\n');
    const bin = mkdtempSync(join(tmpdir(), 'adk-bin-'));
    const envRecebido = join(bin, 'env-recebido.txt');
    const uv = join(bin, 'uv');
    // Escrita atômica: o `>` cria o arquivo vazio antes de o `env` escrever, e
    // o `esperarArquivo` devolve assim que o arquivo existe — leria ''.
    writeFileSync(uv, `#!/bin/sh\n/usr/bin/env > "${envRecebido}.tmp" && /bin/mv "${envRecebido}.tmp" "${envRecebido}"\n`);
    chmodSync(uv, 0o755);

    const { ctx } = ctxDeTeste(dir, {
      PATH: bin,
      MCP_TOKEN: 'token-dev-python',
      ADK_TOKEN: 'segredo-do-hub-que-nao-pode-vazar',
    });
    const servidor = supervisor(ctx, dir);
    try {
      const env = await esperarArquivo(envRecebido);
      expect(env).toMatch(/^MCP_TOKEN=token-dev-python$/m);
      expect(env).not.toContain('segredo-do-hub-que-nao-pode-vazar');
    } finally {
      servidor.encerrar();
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('kind: mcp não passa pelo caminho que exige tools/*.py', async () => {
    // Regressão direta do IndexError: com `tools/` AUSENTE (o que o
    // `adk init mcp` gera) e `server.py` presente, o ramo escolhido é o do
    // servidor — provado pela ausência do erro de entrada do ramo de tool.
    writeFileSync(join(dir, 'manifest.yaml'), MANIFESTO_MCP);
    mkdirSync(join(dir, 'dev'), { recursive: true });
    writeFileSync(join(dir, 'dev', 'sample-input.json'), '{}');
    const { ctx, err } = ctxDeTeste(dir);
    const codigo = await comandoDev(ctx, { dir });
    expect(codigo).toBe(2);
    expect(err.join('\n')).toContain('kind: mcp');
  });
});

// O QA mediu: `uv run python server.py < /dev/null` sai com 0 (o FastMCP em
// stdio encerra limpo no EOF). Um `adk dev` sem terminal — agente headless,
// CI, nohup — deixava ZERO servidores vivos e não dizia uma palavra, porque o
// aviso dependia de `codigo !== 0`. O sinal tem de ser o tempo de vida.
describe('adk dev — kind: mcp: servidor que nasce e morre', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-dev-mcp-efemero-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('servidor que sai na hora é reportado mesmo saindo com 0', async () => {
    writeFileSync(join(dir, 'manifest.yaml'), MANIFESTO_MCP);
    writeFileSync(join(dir, ARQUIVO_SERVIDOR), 'print("servidor")\n');
    const bin = mkdtempSync(join(tmpdir(), 'adk-bin-'));
    const uv = join(bin, 'uv');
    writeFileSync(uv, '#!/bin/sh\nexit 0\n');
    chmodSync(uv, 0o755);

    const { ctx, out } = ctxDeTeste(dir, { PATH: bin });
    const servidor = supervisor(ctx, dir);
    try {
      const avisou = async (): Promise<boolean> => {
        for (let i = 0; i < 40; i++) {
          if (out.join('\n').includes('encerrou assim que subiu')) return true;
          await new Promise((r) => setTimeout(r, 50));
        }
        return false;
      };
      expect(await avisou()).toBe(true);
      // E não anuncia "de pé" um servidor que morreu.
      expect(out.join('\n')).not.toContain('servidor de pé');
    } finally {
      servidor.encerrar();
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

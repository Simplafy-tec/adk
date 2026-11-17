import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { comandoDev } from '../src/commands/dev.js';
import { supervisor } from '../src/commands/dev-mcp.js';
import type { Ctx } from '../src/ctx.js';

// Hub#2.6.26.4 — `adk dev` de `kind: mcp` decide o runtime pelo ARTEFATO
// presente, não por campo novo no manifesto: `server.py` presente é o caminho
// Python de hoje (zero regressão); `server.py` ausente e `package.json`
// presente é o satélite Node. O ciclo de save/crash do PROCESSO `adk dev` está
// em `dev-mcp-node-processo.test.ts`; aqui, o despacho e o ambiente.

function ctxDeTeste(cwd: string, env: NodeJS.ProcessEnv) {
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
  'slug: demo-plugin-mcp-node',
  'name: Demo plugin MCP Node',
  '',
].join('\n');

function fakeExecutavel(bin: string, nome: string, script: string): void {
  const caminho = join(bin, nome);
  writeFileSync(caminho, script);
  chmodSync(caminho, 0o755);
}

async function esperarArquivo(caminho: string, tentativas = 100): Promise<string> {
  for (let i = 0; i < tentativas; i++) {
    if (existsSync(caminho)) {
      const texto = readFileSync(caminho, 'utf8');
      if (texto.length > 0) return texto;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return '';
}

function componenteNode(dir: string, opcoes: { comDependencias: boolean }): void {
  writeFileSync(join(dir, 'manifest.yaml'), MANIFESTO_MCP);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'demo-plugin-mcp-node', scripts: { dev: 'tsx src/server.ts', test: 'tsx --test' } }),
  );
  if (opcoes.comDependencias) mkdirSync(join(dir, 'node_modules'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'server.ts'), '// stub\n');
}

describe('adk dev — kind: mcp, runtime node (detecção por artefato)', () => {
  let dir: string;
  let bin: string;
  let log: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-dev-mcp-node-'));
    bin = mkdtempSync(join(tmpdir(), 'adk-dev-mcp-node-bin-'));
    log = join(bin, 'chamadas.log');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  it('server.py AUSENTE + package.json presente ⇒ sobe `npm run dev`, não `uv run python server.py`', async () => {
    componenteNode(dir, { comDependencias: true });
    fakeExecutavel(bin, 'npm', `#!/bin/sh\necho "npm $@" >> "${log}"\n`);
    fakeExecutavel(bin, 'uv', `#!/bin/sh\necho "uv $@" >> "${log}"\n`);

    const { ctx } = ctxDeTeste(dir, { PATH: bin });
    const servidor = supervisor(ctx, dir);
    try {
      const chamadas = await esperarArquivo(log);
      expect(chamadas).toContain('npm run dev');
      expect(chamadas).not.toContain('uv ');
    } finally {
      servidor.encerrar();
    }
  });

  it('server.py presente continua Python mesmo com package.json na pasta (zero regressão)', async () => {
    componenteNode(dir, { comDependencias: true });
    writeFileSync(join(dir, 'server.py'), 'print("servidor")\n');
    fakeExecutavel(bin, 'npm', `#!/bin/sh\necho "npm $@" >> "${log}"\n`);
    fakeExecutavel(bin, 'uv', `#!/bin/sh\necho "uv $@" >> "${log}"\n`);

    const { ctx } = ctxDeTeste(dir, { PATH: bin });
    const servidor = supervisor(ctx, dir);
    try {
      const chamadas = await esperarArquivo(log);
      expect(chamadas).toContain('uv run python server.py');
      expect(chamadas).not.toContain('npm ');
    } finally {
      servidor.encerrar();
    }
  });

  it('componente Node sem dependências instaladas ⇒ exit 2 citando `npm install`, sem spawn e sem stack trace', async () => {
    componenteNode(dir, { comDependencias: false });
    fakeExecutavel(bin, 'npm', `#!/bin/sh\necho "npm $@" >> "${log}"\n`);

    const { ctx, err } = ctxDeTeste(dir, { PATH: bin });
    const codigo = await comandoDev(ctx, { dir });

    expect(codigo).toBe(2);
    expect(err.join('\n')).toContain('npm install');
    expect(err.join('\n')).not.toMatch(/Traceback|at .*\.js:\d+/);
    expect(existsSync(log)).toBe(false);
  });

  it('nem server.py nem package.json ⇒ exit 2 citando as duas formas, sem IndexError', async () => {
    writeFileSync(join(dir, 'manifest.yaml'), MANIFESTO_MCP);
    const { ctx, err } = ctxDeTeste(dir, { PATH: bin });
    const codigo = await comandoDev(ctx, { dir });

    expect(codigo).toBe(2);
    expect(err.join('\n')).toContain('server.py');
    expect(err.join('\n')).toContain('package.json');
    expect(err.join('\n')).not.toContain('IndexError');
  });

  it('MCP_TOKEN, PORT e BIND_ADDRESS do operador chegam ao satélite Node; ADK_TOKEN e ADK_HUB_URL não', async () => {
    // Sem MCP_TOKEN o esqueleto responde 503 e o autor não exercita nem o
    // próprio `tools/list`; sem PORT ele não escolhe a porta local. Já
    // ADK_TOKEN/ADK_HUB_URL são credencial do HUB — entregá-las ao processo de
    // um satélite de terceiro é o que a allowlist do `envMinimo` impede.
    componenteNode(dir, { comDependencias: true });
    const envRecebido = join(bin, 'env-recebido.txt');
    fakeExecutavel(bin, 'npm', `#!/bin/sh\n/usr/bin/env > "${envRecebido}"\n`);

    const { ctx } = ctxDeTeste(dir, {
      PATH: bin,
      MCP_TOKEN: 'abc',
      PORT: '18123',
      BIND_ADDRESS: '0.0.0.0',
      ADK_TOKEN: 'segredo-do-hub-que-nao-pode-vazar',
      ADK_HUB_URL: 'http://hub-mock.test',
    });
    const servidor = supervisor(ctx, dir);
    try {
      const env = await esperarArquivo(envRecebido);
      expect(env).toMatch(/^MCP_TOKEN=abc$/m);
      expect(env).toMatch(/^PORT=18123$/m);
      expect(env).toMatch(/^BIND_ADDRESS=0\.0\.0\.0$/m);
      expect(env).not.toContain('segredo-do-hub-que-nao-pode-vazar');
      expect(env).not.toMatch(/^ADK_TOKEN=/m);
      expect(env).not.toMatch(/^ADK_HUB_URL=/m);
    } finally {
      servidor.encerrar();
    }
  });
});

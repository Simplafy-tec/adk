import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { gerarSatelite } from './satelite-processo.js';

// Hub#2.6.26.4 — `comandoTest` era literalmente `uv run pytest`, sem despacho
// por runtime. Num componente Node isso dispara pytest num pacote sem Python;
// o pedido é que `adk test` rode o harness do PRÓPRIO componente e falhe com
// mensagem acionável quando as dependências não estão instaladas.
//
// Dev note 3 (1º satélite real): a dependência nativa (WeasyPrint/pango) só
// quebrava quando a tool era CHAMADA — o import passava. O harness gerado tem
// de exercitar o caminho da chamada, não só o import: a tool de exemplo que
// lança na chamada tem de reprovar o `adk test`, nos dois runtimes.

/** Troca o retorno `pong` da tool de exemplo por um erro lançado NA CHAMADA. */
function quebrarNaChamadaNode(alvo: string): void {
  const caminho = join(alvo, 'src', 'server.ts');
  const original = readFileSync(caminho, 'utf8');
  const quebrado = original.replace(
    /(['"`])pong\1/g,
    "(() => { throw new Error('lib nativa ausente em runtime'); })()",
  );
  // Sem a troca o teste passaria vazio: a premissa é que a tool devolve `pong`.
  expect(quebrado).not.toBe(original);
  writeFileSync(caminho, quebrado);
}

function quebrarNaChamadaPython(alvo: string): void {
  const caminho = join(alvo, 'server.py');
  const original = readFileSync(caminho, 'utf8');
  const quebrado = original.replace(
    /return\s+(['"])pong\1/,
    'raise RuntimeError("lib nativa ausente em runtime")',
  );
  expect(quebrado).not.toBe(original);
  writeFileSync(caminho, quebrado);
}

describe('adk test — componente Node', () => {
  let dir: string;
  let bin: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-test-mcp-node-'));
    bin = mkdtempSync(join(tmpdir(), 'adk-test-mcp-node-bin-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  it('sem dependências instaladas ⇒ mensagem acionável citando `npm install`, sem disparar pytest', async () => {
    const alvo = join(dir, 'satelite-node');
    const init = await runCli(['init', 'mcp', '--runtime', 'node', 'satelite-node', '--dir', alvo], {
      cwd: dir,
    });
    expect(init.exitCode).toBe(0);
    // SEM node_modules/ de propósito.

    const log = join(bin, 'chamadas.log');
    const uvFalso = join(bin, 'uv');
    writeFileSync(uvFalso, `#!/bin/sh\necho "uv $@" >> "${log}"\nexit 1\n`);
    chmodSync(uvFalso, 0o755);

    const result = await runCli(['test', '--dir', alvo], { env: { PATH: bin } });
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('npm install');
    expect(`${result.stdout}${result.stderr}`).not.toContain('pytest');
    expect(() => readFileSync(log, 'utf8')).toThrow();
  });

  it('o harness gerado roda e passa sem edição (exit 0)', async () => {
    const alvo = await gerarSatelite(dir, 'node');
    const result = await runCli(['test', '--dir', alvo], { cwd: dir });
    expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(0);
  }, 60_000);

  it('tool de exemplo que quebra NA CHAMADA reprova o `adk test` — o harness exercita a chamada, não só o import', async () => {
    const alvo = await gerarSatelite(dir, 'node');
    quebrarNaChamadaNode(alvo);
    const result = await runCli(['test', '--dir', alvo], { cwd: dir });
    expect(result.exitCode).not.toBe(0);
  }, 60_000);
});

describe('adk test — componente Python (caminho default)', () => {
  let dir: string;
  let bin: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-test-mcp-py-'));
    bin = mkdtempSync(join(tmpdir(), 'adk-test-mcp-py-bin-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  it('componente Python (server.py) continua rodando `uv run pytest`, inalterado', async () => {
    const alvo = join(dir, 'satelite-python');
    await runCli(['init', 'mcp', 'satelite-python', '--dir', alvo], { cwd: dir });

    const log = join(bin, 'chamadas.log');
    const uvFalso = join(bin, 'uv');
    writeFileSync(uvFalso, `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`);
    chmodSync(uvFalso, 0o755);

    const result = await runCli(['test', '--dir', alvo], { env: { PATH: bin } });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(log, 'utf8')).toContain('run pytest');
  });

  it('o harness Python gerado passa sem edição (uv real)', async () => {
    const alvo = await gerarSatelite(dir, 'python');
    const result = await runCli(['test', '--dir', alvo], { cwd: dir });
    expect(result.exitCode, result.stdout).toBe(0);
  }, 120_000);

  it('tool de exemplo que quebra NA CHAMADA reprova o `adk test` Python — não basta importar o server', async () => {
    const alvo = await gerarSatelite(dir, 'python');
    quebrarNaChamadaPython(alvo);
    const result = await runCli(['test', '--dir', alvo], { cwd: dir });
    expect(result.exitCode).not.toBe(0);
  }, 120_000);
});

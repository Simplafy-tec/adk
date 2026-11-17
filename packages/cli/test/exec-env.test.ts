import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

// Item 9 do brief de correção: `adk build` roda `uv lock`/`uv run ruff check`
// sobre o código de um componente de TERCEIRO — hoje o subprocesso recebe
// `ctx.env` inteiro, inclusive ADK_TOKEN/ADK_HUB_URL. Um script malicioso no
// componente consegue ler o token do Hub do próprio ambiente.

describe('adk build — o subprocesso `uv` não recebe ADK_TOKEN/ADK_HUB_URL', () => {
  let dir: string;
  let binDir: string;
  let envRecebidoFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-exec-env-'));
    binDir = mkdtempSync(join(tmpdir(), 'adk-exec-env-bin-'));
    envRecebidoFile = join(dir, 'env-recebido.txt');

    // `uv` falso: grava o próprio ambiente recebido num arquivo de caminho
    // absoluto FIXO no script (não via variável de ambiente — é justamente o
    // que este teste desconfia) e sai com sucesso para qualquer subcomando.
    const uvFalso = ['#!/bin/sh', `env > "${envRecebidoFile}"`, 'exit 0', ''].join('\n');
    writeFileSync(join(binDir, 'uv'), uvFalso);
    chmodSync(join(binDir, 'uv'), 0o755);

    writeFileSync(
      join(dir, 'manifest.yaml'),
      [
        'spec_version: v1',
        'kind: tool',
        'slug: hello',
        'definition:',
        '  name: hello',
        '  description: Diz olá para quem chamar, com mais de vinte caracteres.',
        '  kind: native',
        '  input_schema:',
        '    type: object',
        '    properties: {}',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "hello"\n');
    mkdirSync(join(dir, 'tools'));
    writeFileSync(
      join(dir, 'tools', 'hello.py'),
      ['def handler(input):', '    return {"ok": True}'].join('\n'),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  it('o ambiente que o `uv` falso recebe não contém ADK_TOKEN nem ADK_HUB_URL', async () => {
    await runCli(['build', '--dir', dir], {
      env: {
        PATH: `${binDir}:${process.env.PATH}`,
        ADK_TOKEN: 'segredo-do-hub-que-nao-pode-vazar',
        ADK_HUB_URL: 'http://hub-mock.test',
      },
    });

    expect(existsSync(envRecebidoFile)).toBe(true);
    const envRecebido = readFileSync(envRecebidoFile, 'utf8');
    expect(envRecebido).not.toContain('segredo-do-hub-que-nao-pode-vazar');
    expect(envRecebido).not.toContain('ADK_TOKEN');
    expect(envRecebido).not.toContain('ADK_HUB_URL');
  });
});

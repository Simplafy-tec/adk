import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import type { Ctx } from '../src/ctx.js';
import {
  HOST_DEV,
  PASTA_SHELL,
  PORTA_DEV_PADRAO,
  arquivosDoShell,
  devApp,
  portaDoShell,
} from '../src/commands/dev-app.js';

// `adk dev` de app sobe o Vite + o HostShell local SÓ em loopback: o Docker/
// firewall não protege porta publicada em 0.0.0.0, e o shell de dev carrega o
// app do usuário com o bridge ligado — nunca pode ficar alcançável na rede.

function ctxDeTeste(cwd: string): { ctx: Ctx; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const ctx = {
    cwd,
    // `devApp` passa `ctx.env` para `envMinimo` ao subir o Vite; sem isto os
    // testes que chegam ao spawn quebram antes de exercitar o que provam.
    env: process.env,
    out: (linha: string) => out.push(linha),
    err: (linha: string) => err.push(linha),
  } as unknown as Ctx;
  return { ctx, out, err };
}

describe('adk dev — app (dev-app)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-dev-app-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('bind é SEMPRE 127.0.0.1 (nunca 0.0.0.0) e a porta padrão é a do Vite', () => {
    expect(HOST_DEV).toBe('127.0.0.1');
    expect(PORTA_DEV_PADRAO).toBe(5173);
    // Não é mais `porta + 1`: 5174 está fora da allowlist do `useHost()` e a
    // ponte nascia morta (issue#2765). O shell nasce numa porta confiável.
    expect(portaDoShell(PORTA_DEV_PADRAO)).toBe(4321);
    expect(PASTA_SHELL).toBe('adk-dev');
  });

  it('arquivosDoShell embute a URL loopback do app e liga shell.html ao shell.tsx', () => {
    const appUrl = `http://${HOST_DEV}:${PORTA_DEV_PADRAO}/`;
    const arquivos = arquivosDoShell('demo-app', appUrl);
    expect(Object.keys(arquivos).sort()).toEqual([
      `${PASTA_SHELL}/shell.html`,
      `${PASTA_SHELL}/shell.tsx`,
    ]);
    expect(arquivos[`${PASTA_SHELL}/shell.html`]).toContain('shell.tsx');
    expect(arquivos[`${PASTA_SHELL}/shell.tsx`]).toContain(appUrl);
    for (const conteudo of Object.values(arquivos)) {
      expect(conteudo).not.toContain('0.0.0.0');
    }
  });

  it('sem node_modules/.bin/vite na raiz do app ⇒ exit 2 com instrução, sem subir processo', async () => {
    const { ctx, err } = ctxDeTeste(dir);
    const exit = await devApp(ctx, dir, 'demo-app', PORTA_DEV_PADRAO);
    expect(exit).toBe(2);
    expect(err.join('\n')).toContain('Vite não encontrado');
  });

  // Item 4 do brief de correção N19: `spec.slug` cru é interpolado em
  // `shell.html`/`shell.tsx` sem validar — `slug` vem do manifest.yaml do
  // usuário e vira HTML/TSX gerado em disco. Exige `/^[a-z0-9-]+$/`, exit 2
  // caso contrário, e SEM escrever os arquivos do shell.
  it('slug fora de /^[a-z0-9-]+$/ ⇒ exit 2, sem escrever os arquivos do shell', async () => {
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '.bin', 'vite'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    });

    const { ctx, err } = ctxDeTeste(dir);
    const slugMalicioso = '<script>alert(1)</script>';
    const exit = await devApp(ctx, dir, slugMalicioso, PORTA_DEV_PADRAO);

    expect(exit).toBe(2);
    expect(err.join('\n').toLowerCase()).toContain('slug');
    expect(existsSync(join(dir, PASTA_SHELL, 'shell.html'))).toBe(false);
    expect(existsSync(join(dir, PASTA_SHELL, 'shell.tsx'))).toBe(false);
  });

  // `devApp` é bem coberto isoladamente acima, mas nada provava que o `adk dev`
  // REALMENTE desvia para ele quando o manifesto é `kind: app` — desligar o
  // desvio em `dev.ts` deixava a suíte verde (mutation check da review).
  // Sem `node_modules/.bin/vite`, o caminho de app termina em exit 2 na hora;
  // o caminho de tool/mcp entraria no watcher e nunca resolveria.
  it('adk dev com manifesto kind: app roteia para devApp (não para o handler Python)', async () => {
    writeFileSync(
      join(dir, 'manifest.yaml'),
      [
        'spec_version: v1',
        'kind: app',
        'slug: demo-app',
        'definition:',
        '  name: demo_app',
        '  display_name: demo-app',
        '  description: App de demonstração com mais de vinte caracteres no total.',
        '  kind: native',
        '  input_schema:',
        '    type: object',
        '    properties: {}',
        '',
      ].join('\n'),
    );

    const resultado = await runCli(['dev', '--dir', dir], { cwd: dir });

    expect(resultado.exitCode).toBe(2);
    expect(resultado.stderr).toContain('Vite não encontrado');
  });

  // Achado ALTO da review: como o resolver estava amarrado só ao processo do
  // APP, um shell que morresse primeiro (porta ocupada com --strictPort) era
  // mascarado — o app morria por sinal (`codigo === null`) e o `?? 0` devolvia
  // sucesso. Quem sai primeiro tem de decidir o exit code.
  it('shell que falha ao subir propaga o código de saída (nunca 0 silencioso)', async () => {
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    // O fake distingue app de shell pela porta: a do app fica viva até ser
    // morta; a do shell (porta+1) sai com 7, como faria o --strictPort.
    writeFileSync(
      join(dir, 'node_modules', '.bin', 'vite'),
      [
        '#!/bin/sh',
        `case "$*" in *"--port ${portaDoShell(PORTA_DEV_PADRAO)}"*) exit 7 ;; esac`,
        'sleep 30',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    const { ctx } = ctxDeTeste(dir);
    // `poll: true` porque o alvo aqui é a propagação do exit code, e o modo
    // poll dispensa a sonda de inotify (issue#2772). Sem isso, o teste passa a
    // medir o ambiente: numa máquina com o inotify no teto — o caso da própria
    // issue — a sonda reprova antes e o exit vira 1.
    const exit = await devApp(ctx, dir, 'demo-app', PORTA_DEV_PADRAO, true);

    expect(exit).toBe(7);
  });
});

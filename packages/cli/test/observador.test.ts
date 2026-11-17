import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { comandoDev } from '../src/commands/dev.js';
import { SemObservadores, observar, observarPorPoll } from '../src/observador.js';
import type { Ctx } from '../src/ctx.js';

// issue#2772 — `fs.watch(dir, {recursive:true})` não lança quando o sistema
// ficou sem watches de inotify: devolve um watcher MUDO. O comando imprimia
// "Observando …" e nunca reagia a save nenhum — silêncio idêntico ao sucesso.

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

const MANIFESTO_TOOL = [
  'spec_version: v1',
  'kind: tool',
  'slug: demo-poll',
  'definition:',
  '  name: demo_poll',
  '  display_name: demo-poll',
  '  description: Tool de teste do observador por polling, com mais de vinte caracteres.',
  '  kind: native',
  '  input_schema:',
  '    type: object',
  '    properties: {}',
  '',
].join('\n');

async function ate(condicao: () => boolean, tentativas = 60): Promise<boolean> {
  for (let i = 0; i < tentativas; i++) {
    if (condicao()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe('observador do adk dev', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-observador-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a falha do observador diz o que fazer, sem exigir privilégio', () => {
    const erro = new SemObservadores('fs.inotify.max_user_watches');
    expect(erro.message).toContain('--poll');
    expect(erro.message).toContain('max_user_watches');
  });

  // issue#2583 — um save gera mais de um evento no inotify (`rename` +
  // `change`, e mais ainda com editor que escreve por arquivo temporário). Sem
  // agrupar, o ciclo de dev roda duas ou três vezes por Ctrl-S.
  it('eventos próximos viram UM lote, não três execuções', async () => {
    writeFileSync(join(dir, 'manifest.yaml'), MANIFESTO_TOOL);
    mkdirSync(join(dir, 'tools'), { recursive: true });
    const lotes: string[][] = [];
    let parar: (() => void) | undefined;
    try {
      parar = observar(dir, (arquivos) => lotes.push(arquivos), { debounceMs: 80 });
    } catch {
      // Máquina com inotify no teto (o caso da issue#2772): sem watcher não há
      // o que agrupar, e o `--poll` já agrupa por tick.
      return;
    }
    try {
      writeFileSync(join(dir, 'manifest.yaml'), `${MANIFESTO_TOOL}# a\n`);
      writeFileSync(join(dir, 'tools', 'x.py'), 'def handler(i):\n    return {}\n');
      writeFileSync(join(dir, 'manifest.yaml'), `${MANIFESTO_TOOL}# b\n`);
      expect(await ate(() => lotes.length > 0)).toBe(true);
      await new Promise((r) => setTimeout(r, 300));
      expect(lotes).toHaveLength(1);
      expect(lotes[0]?.length).toBeGreaterThanOrEqual(2);
    } finally {
      parar?.();
    }
  });

  // issue#2583, causa REAL — achada na validação: não era falta de debounce. O
  // handler que o `adk dev` acabou de executar regrava o `.pyc`, o observador
  // vê o arquivo novo e executa de novo. Os dois disparos ficam a um tick de
  // distância, então nenhum agrupamento os juntaria.
  it('o cache do Python não realimenta o ciclo', async () => {
    writeFileSync(join(dir, 'manifest.yaml'), MANIFESTO_TOOL);
    mkdirSync(join(dir, 'tools', '__pycache__'), { recursive: true });
    const salvos: string[] = [];
    const parar = observarPorPoll(dir, (arquivos) => salvos.push(...arquivos), 50);
    try {
      writeFileSync(
        join(dir, 'tools', '__pycache__', 'demo_poll.cpython-312.pyc'),
        'bytecode qualquer',
      );
      // `.pytest_cache` não tem extensão que denuncie: só a lista de pastas o
      // filtra. Sem este caso, a lista poderia sumir e o teste continuaria
      // verde por causa do filtro de `.pyc`.
      mkdirSync(join(dir, '.pytest_cache', 'v', 'cache'), { recursive: true });
      writeFileSync(join(dir, '.pytest_cache', 'v', 'cache', 'lastfailed'), '{}');
      await new Promise((r) => setTimeout(r, 300));
      expect(salvos).toEqual([]);
      // E o arquivo que importa continua acordando o ciclo.
      writeFileSync(join(dir, 'manifest.yaml'), `${MANIFESTO_TOOL}# tocado\n`);
      expect(await ate(() => salvos.includes('manifest.yaml'))).toBe(true);
    } finally {
      parar();
    }
  });

  it('o polling avisa quando um arquivo muda, e só então', async () => {
    writeFileSync(join(dir, 'manifest.yaml'), MANIFESTO_TOOL);
    const salvos: string[] = [];
    const parar = observarPorPoll(dir, (arquivos) => salvos.push(...arquivos), 50);
    try {
      await new Promise((r) => setTimeout(r, 200));
      expect(salvos).toEqual([]);
      writeFileSync(join(dir, 'manifest.yaml'), `${MANIFESTO_TOOL}# tocado\n`);
      expect(await ate(() => salvos.includes('manifest.yaml'))).toBe(true);
    } finally {
      parar();
    }
  });

  // O teste acima prova a FUNÇÃO. Este prova o PRODUTO: o `adk dev --poll`
  // como processo, que é onde o defeito real morava — um `setInterval` com
  // `unref()` não segura o event loop, o Node encerra o loop e o poll nunca
  // dispara. O teste de função não pegava porque o laço de espera dele mantinha
  // o loop vivo por fora (achado do QA na validação).
  it('o PROCESSO `adk dev --poll` reexecuta o handler a cada save', async () => {
    writeFileSync(join(dir, 'manifest.yaml'), MANIFESTO_TOOL);
    mkdirSync(join(dir, 'dev'), { recursive: true });
    writeFileSync(join(dir, 'dev', 'sample-input.json'), '{}');
    mkdirSync(join(dir, 'tools'), { recursive: true });
    writeFileSync(join(dir, 'tools', 'demo_poll.py'), 'def handler(input):\n    return {}\n');

    const bin = mkdtempSync(join(tmpdir(), 'adk-bin-'));
    const uv = join(bin, 'uv');
    writeFileSync(uv, '#!/bin/sh\necho executou\n');
    chmodSync(uv, 0o755);

    const binPath = fileURLToPath(new URL('../src/bin.ts', import.meta.url));
    const processo = spawn('npx', ['tsx', binPath, 'dev', '--dir', dir, '--poll'], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    let saida = '';
    processo.stdout.on('data', (c) => (saida += String(c)));
    processo.stderr.on('data', (c) => (saida += String(c)));
    const execucoes = (): number => saida.split('executou').length - 1;

    try {
      expect(await ate(() => execucoes() >= 1, 200)).toBe(true);
      let reexecutou = false;
      for (let i = 0; i < 20 && !reexecutou; i++) {
        writeFileSync(join(dir, 'tools', 'demo_poll.py'), `def handler(input):\n    return {"v": ${i}}\n`);
        reexecutou = await ate(() => execucoes() >= 2, 10);
      }
      expect(reexecutou).toBe(true);
    } finally {
      processo.kill();
      rmSync(bin, { recursive: true, force: true });
    }
  }, 60_000);

  it('`adk dev --poll` reexecuta o handler a cada save, sem inotify', async () => {
    writeFileSync(join(dir, 'manifest.yaml'), MANIFESTO_TOOL);
    mkdirSync(join(dir, 'dev'), { recursive: true });
    writeFileSync(join(dir, 'dev', 'sample-input.json'), '{}');
    mkdirSync(join(dir, 'tools'), { recursive: true });
    writeFileSync(join(dir, 'tools', 'demo_poll.py'), 'def handler(input):\n    return {}\n');

    // `uv` falso: registra cada execução do handler.
    const bin = mkdtempSync(join(tmpdir(), 'adk-bin-'));
    const uv = join(bin, 'uv');
    writeFileSync(uv, '#!/bin/sh\necho chamada >> chamadas.log\n');
    chmodSync(uv, 0o755);

    const chamadas = (): number =>
      existsSync(join(dir, 'chamadas.log'))
        ? readFileSync(join(dir, 'chamadas.log'), 'utf8').trim().split('\n').length
        : 0;

    const { ctx } = ctxDeTeste(dir, { PATH: bin });
    void comandoDev(ctx, { dir, poll: true });
    try {
      // A primeira execução é a de partida, antes do observador existir.
      expect(await ate(() => chamadas() >= 1)).toBe(true);
      // Salva de novo a cada rodada: o observador só começa a medir depois da
      // execução de partida, e um save anterior ao primeiro snapshot entraria
      // nele em vez de disparar.
      let reexecutou = false;
      for (let i = 0; i < 20 && !reexecutou; i++) {
        writeFileSync(join(dir, 'tools', 'demo_poll.py'), `def handler(input):\n    return {"v": ${i}}\n`);
        reexecutou = await ate(() => chamadas() >= 2, 6);
      }
      expect(reexecutou).toBe(true);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  }, 30_000);
});

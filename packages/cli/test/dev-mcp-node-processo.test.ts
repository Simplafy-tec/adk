import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BIN_CLI,
  ate,
  encerrarArvore,
  envSemToken,
  esperarHealth200,
  gerarSatelite,
  listarTools,
  portaLivre,
  statusHealth,
  subir,
  type ProcessoVivo,
} from './satelite-processo.js';

// Hub#2.6.26.4 — `adk dev` de um satélite Node reinicia o servidor a cada
// save e NÃO morre quando o servidor quebra. Isso só se prova com o PROCESSO
// `adk dev` de verdade: dentro do vitest o event loop nunca esvazia, e o
// defeito medido no 2º verify de runtime (o `adk dev` saindo sozinho com
// exit 13 no instante em que o filho morria por sinal) não aparece.
//
// `--poll`: o inotify deste tipo de host já se mostrou exaurido; sem ele o
// teste não seria determinístico.

const MANIFESTO_MCP_NODE = [
  'spec_version: v1',
  'kind: mcp',
  'slug: demo-crash-processo',
  'name: Demo crash processo',
  '',
].join('\n');

function processoVivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function adkDev(dir: string, env: NodeJS.ProcessEnv): ProcessoVivo {
  return subir(process.execPath, [BIN_CLI, 'dev', '--dir', dir, '--poll'], { cwd: dir, env });
}

describe('adk dev — satélite Node: o servidor morre, o `adk dev` não (npm falso)', () => {
  let dir: string;
  let bin: string;
  let pidfile: string;
  let dev: ProcessoVivo | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-dev-crash-'));
    bin = mkdtempSync(join(tmpdir(), 'adk-dev-crash-bin-'));
    pidfile = join(bin, 'servidor.pid');

    writeFileSync(join(dir, 'manifest.yaml'), MANIFESTO_MCP_NODE);
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'demo-crash-processo', scripts: { dev: 'tsx src/server.ts' } }),
    );
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'server.ts'), '// stub\n');

    // "npm run dev" falso: registra o próprio PID e fica de pé até ser morto.
    // `exec sleep` para o PID registrado ser o do processo que de fato espera.
    const npmFalso = join(bin, 'npm');
    writeFileSync(npmFalso, ['#!/bin/sh', `echo "$$" >> "${pidfile}"`, 'exec sleep 300', ''].join('\n'));
    chmodSync(npmFalso, 0o755);
  });

  afterEach(async () => {
    await dev?.encerrar();
    dev = undefined;
    rmSync(dir, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }, 15_000);

  const pids = (): number[] =>
    existsSync(pidfile)
      ? readFileSync(pidfile, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(Number)
      : [];

  it('servidor morto por fora (kill -9): o `adk dev` reporta, continua vivo e o próximo save sobe outro processo', async () => {
    dev = adkDev(dir, { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` });

    expect(await ate(() => pids().length >= 1, 15_000)).toBe(true);
    const pid1 = pids()[0] as number;
    const antes = dev.saida().length;

    process.kill(pid1, 'SIGKILL');

    // Sentinela: o aviso do supervisor. Todo término do FILHO tem mensagem —
    // inclusive o kill -9, que chega como `codigo === null`.
    const reportou = await ate(
      () => /servidor[^\n]*(encerr|saiu|caiu|morr)/i.test(dev!.saida().slice(antes)),
      10_000,
    );
    expect(reportou, dev.saida()).toBe(true);
    expect(dev.processo.exitCode).toBeNull();
    expect(processoVivo(dev.processo.pid as number)).toBe(true);

    writeFileSync(join(dir, 'src', 'server.ts'), '// stub alterado após o crash\n');
    expect(await ate(() => pids().length >= 2, 15_000), dev.saida()).toBe(true);
    expect(pids()[1]).not.toBe(pid1);
  }, 60_000);

  it('save em src/ reinicia o servidor: o processo anterior morre e um novo sobe', async () => {
    dev = adkDev(dir, { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` });

    expect(await ate(() => pids().length >= 1, 15_000)).toBe(true);
    const pid1 = pids()[0] as number;

    writeFileSync(join(dir, 'src', 'server.ts'), '// stub alterado\n');
    expect(await ate(() => pids().length >= 2, 15_000), dev.saida()).toBe(true);
    // O anterior não pode ficar órfão segurando a porta (EADDRINUSE perpétuo).
    expect(await ate(() => !processoVivo(pid1), 5_000)).toBe(true);
    expect(processoVivo(pids()[1] as number)).toBe(true);
  }, 60_000);
});

// Revisão da Hub#2.6.26.4 (blocker): o satélite é `detached` — líder do
// PRÓPRIO grupo — para o reinício matar a árvore `npm → sh → tsx → node`
// inteira. Efeito colateral: o Ctrl-C do terminal (SIGINT ao grupo do
// `adk dev`) e o SIGTERM do orquestrador não chegam a ele. O `adk dev`
// morre e o satélite fica ÓRFÃO segurando a porta — o próximo `adk dev`
// nasce em EADDRINUSE. Vale para os dois runtimes: o supervisor é o mesmo.
describe.each([
  ['node', 'npm'],
  ['python', 'uv'],
] as const)('adk dev — satélite %s: o `adk dev` encerrado não deixa o satélite órfão', (runtime, executavel) => {
  let dir: string;
  let bin: string;
  let pidfile: string;
  let dev: ProcessoVivo | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `adk-dev-orfao-${runtime}-`));
    bin = mkdtempSync(join(tmpdir(), `adk-dev-orfao-${runtime}-bin-`));
    pidfile = join(bin, 'satelite.pid');
    writeFileSync(join(dir, 'manifest.yaml'), MANIFESTO_MCP_NODE);
    if (runtime === 'node') {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'demo-orfao', scripts: { dev: 'tsx src/server.ts' } }),
      );
      mkdirSync(join(dir, 'node_modules'), { recursive: true });
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'server.ts'), '// stub\n');
    } else {
      writeFileSync(join(dir, 'server.py'), 'print("servidor")\n');
    }
    // O satélite falso: registra o PID e espera ser morto (`exec` para o PID
    // registrado ser o do processo que de fato fica de pé).
    const falso = join(bin, executavel);
    writeFileSync(falso, ['#!/bin/sh', `echo "$$" >> "${pidfile}"`, 'exec sleep 300', ''].join('\n'));
    chmodSync(falso, 0o755);
  });

  afterEach(async () => {
    await dev?.encerrar();
    dev = undefined;
    // Rede de segurança: o teste vermelho não pode deixar o órfão na máquina.
    for (const pid of lerPids(pidfile)) await encerrarArvore(pid);
    rmSync(dir, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }, 15_000);

  it.each(['SIGINT', 'SIGTERM'] as const)(
    '%s ao grupo de processos do `adk dev` encerra o `adk dev` E o satélite',
    async (sinal) => {
      dev = adkDev(dir, { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` });
      expect(await ate(() => lerPids(pidfile).length >= 1, 15_000), dev.saida()).toBe(true);
      const satelite = lerPids(pidfile)[0] as number;
      const pidDev = dev.processo.pid as number;
      expect(processoVivo(satelite)).toBe(true);

      // O que o terminal faz no Ctrl-C: o sinal vai ao GRUPO em primeiro plano.
      process.kill(-pidDev, sinal);

      expect(await ate(() => !processoVivo(pidDev), 5_000), 'o `adk dev` não encerrou').toBe(true);
      expect(
        await ate(() => !processoVivo(satelite), 5_000),
        `o satélite (pid ${satelite}) ficou órfão depois do ${sinal} no \`adk dev\``,
      ).toBe(true);
    },
    30_000,
  );
});

function lerPids(arquivo: string): number[] {
  return existsSync(arquivo)
    ? readFileSync(arquivo, 'utf8').trim().split('\n').filter(Boolean).map(Number)
    : [];
}

describe('adk dev — satélite Node gerado pelo `adk init` (processo real, sem edição)', () => {
  let dir: string;
  let dev: ProcessoVivo | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-dev-node-real-'));
  });

  afterEach(async () => {
    await dev?.encerrar();
    dev = undefined;
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  it('sobe o servidor na PORT pedida, com o MCP_TOKEN do operador, e responde tools/list', async () => {
    const alvo = await gerarSatelite(dir, 'node');
    const porta = await portaLivre();
    dev = adkDev(alvo, envSemToken({ PORT: String(porta), MCP_TOKEN: 'token-dev' }));

    expect(await esperarHealth200(porta, 30_000), dev.saida()).toBe(true);
    expect(await listarTools(porta, 'token-dev')).toContain('ping');
  }, 60_000);

  it('reinicia a cada save e sobrevive ao servidor quebrado: erro → aviso, conserto → de pé de novo', async () => {
    const alvo = await gerarSatelite(dir, 'node');
    const porta = await portaLivre();
    const arquivo = join(alvo, 'src', 'server.ts');
    const original = readFileSync(arquivo, 'utf8');
    dev = adkDev(alvo, envSemToken({ PORT: String(porta), MCP_TOKEN: 'token-dev' }));
    expect(await esperarHealth200(porta, 30_000), dev.saida()).toBe(true);

    // 1. Save válido ⇒ o servidor NOVO (com a marca) sobe e responde na mesma porta.
    writeFileSync(arquivo, `${original}\nconsole.error('marca-de-reinicio-1');\n`);
    expect(await ate(() => dev!.saida().includes('marca-de-reinicio-1'), 30_000), dev.saida()).toBe(true);
    expect(await esperarHealth200(porta, 30_000), dev.saida()).toBe(true);

    // 2. Save quebrado ⇒ o servidor cai, o `adk dev` avisa e continua vivo.
    const antes = dev.saida().length;
    writeFileSync(arquivo, `${original}\nconst = ;\n`);
    expect(await ate(async () => (await statusHealth(porta)) === undefined, 30_000)).toBe(true);
    expect(
      await ate(() => /servidor[^\n]*(saiu|encerr|caiu|corrija)/i.test(dev!.saida().slice(antes)), 30_000),
      dev.saida(),
    ).toBe(true);
    expect(dev.processo.exitCode).toBeNull();
    expect(processoVivo(dev.processo.pid as number)).toBe(true);

    // 3. Conserto ⇒ de pé de novo, sem reiniciar o `adk dev`.
    writeFileSync(arquivo, `${original}\nconsole.error('marca-de-reinicio-2');\n`);
    expect(await ate(() => dev!.saida().includes('marca-de-reinicio-2'), 30_000), dev.saida()).toBe(true);
    expect(await esperarHealth200(porta, 30_000), dev.saida()).toBe(true);
  }, 150_000);
});

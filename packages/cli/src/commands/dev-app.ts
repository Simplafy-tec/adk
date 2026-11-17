/**
 * `adk dev` para `kind: app` — Vite (HMR) + Hub shell local, no mesmo servidor.
 *
 * O shell NÃO é um segundo servidor: é uma segunda página HTML servida pelo
 * próprio Vite do app, em `adk-dev/shell.html`. Assim o shell usa o `HostShell`
 * de verdade do `@simpla.fy/app-kit` (não uma maquete que diverge do Hub),
 * ganha HMR de graça e não acrescenta uma dependência de servidor à CLI.
 *
 * `127.0.0.1` sempre, nunca `0.0.0.0`: servidor de desenvolvimento não sai da
 * máquina de quem está desenvolvendo.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { envMinimo } from '../exec.js';
import { SemObservadores, sondarObservadores } from '../observador.js';
import type { Ctx } from '../ctx.js';

export const HOST_DEV = '127.0.0.1';
export const PORTA_DEV_PADRAO = 5173;

/**
 * Pasta gerada do shell — não versionada (está no `.gitignore` do template).
 * O `adk build` VARRE esta pasta de propósito: desde a rodada de correção da
 * N19 o portão não pula diretório gerado nenhum, porque era exatamente assim
 * que um segredo largado num artefato de build passava direto.
 */
export const PASTA_SHELL = 'adk-dev';
const SLUG_VALIDO = /^[a-z0-9-]+$/;

/**
 * Portas locais que o `@simpla.fy/app-kit` aceita como host (`origens.ts`).
 * Duplicada aqui de propósito: a CLI publicada não depende do app-kit (React),
 * e `test/allowlist-shell.test.ts` reprova se as duas listas divergirem.
 */
export const PORTAS_CONFIAVEIS_DO_SHELL: readonly number[] = [4321, 5173, 6006];

/**
 * O shell tem de nascer numa porta que o APP confie (issue#2765).
 *
 * Era `portaApp + 1`, e o default virava 5174 — fora da allowlist do
 * `useHost()`. Com isso `hostOrigin` ficava `null` e a ponte virava no-op
 * silencioso nos dois sentidos: nem o `ready` do app chegava, nem o tema do
 * host voltava. A tela abria e parecia certa. A única forma de acertar era
 * passar `--port` uma unidade abaixo de uma porta confiável — coincidência,
 * não uso.
 */
export function portaDoShell(portaApp: number): number {
  const livre = PORTAS_CONFIAVEIS_DO_SHELL.find((p) => p !== portaApp);
  // A lista tem três entradas e a porta do app é uma só: `livre` sempre existe.
  return livre ?? PORTAS_CONFIAVEIS_DO_SHELL[0]!;
}

export function arquivosDoShell(slug: string, appUrl: string): Record<string, string> {
  return {
    [`${PASTA_SHELL}/shell.html`]: [
      '<!doctype html>',
      '<html lang="pt-BR">',
      '  <head>',
      '    <meta charset="UTF-8" />',
      `    <title>Hub shell — ${slug}</title>`,
      '  </head>',
      '  <body>',
      '    <div id="shell"></div>',
      '    <script type="module" src="./shell.tsx"></script>',
      '  </body>',
      '</html>',
      '',
    ].join('\n'),
    [`${PASTA_SHELL}/shell.tsx`]: [
      '// Gerado por `adk dev` — não versione, não edite.',
      "import { createRoot } from 'react-dom/client';",
      "import { HostShell } from '@simpla.fy/app-kit';",
      '// O CSS do app: o shell tem de renderizar com os MESMOS tokens da tela.',
      "import '../src/index.css';",
      '',
      "const raiz = document.getElementById('shell');",
      'if (!raiz) throw new Error(\'shell.html sem <div id="shell">.\');',
      '',
      'createRoot(raiz).render(',
      '  <HostShell',
      `    appUrl="${appUrl}"`,
      `    title="${slug} — Hub shell local"`,
      '    onNavigate={(path) => console.info(`[shell] navigate: ${path}`)}',
      '  />,',
      ');',
      '',
    ].join('\n'),
  };
}

export async function devApp(
  ctx: Ctx,
  raiz: string,
  slug: string,
  porta: number,
  poll = false,
): Promise<number> {
  if (!SLUG_VALIDO.test(slug)) {
    ctx.err('Slug inválido — use somente letras minúsculas, números e hífens.');
    return 2;
  }

  const vite = join(raiz, 'node_modules', '.bin', 'vite');
  if (!existsSync(vite)) {
    ctx.err('Vite não encontrado — rode `npm install` na pasta do app antes do `adk dev`.');
    return 2;
  }

  const appUrl = `http://${HOST_DEV}:${porta}/`;
  const shellUrl = `http://${HOST_DEV}:${portaDoShell(porta)}/`;
  for (const [rel, conteudo] of Object.entries(arquivosDoShell(slug, appUrl))) {
    const caminho = join(raiz, rel);
    mkdirSync(join(caminho, '..'), { recursive: true });
    writeFileSync(caminho, conteudo);
  }

  // Sem observador o Vite morre com 30 linhas de stack trace de dentro do
  // `node_modules` — o `adk dev` só repassava. Melhor descobrir antes e dizer
  // o que fazer (issue#2772).
  if (!poll) {
    try {
      sondarObservadores(raiz);
    } catch (erro) {
      if (erro instanceof SemObservadores) {
        ctx.err(erro.message);
        return 1;
      }
      throw erro;
    }
  }

  // `ADK_SHELL_PORT` saiu daqui: era exportada para os dois processos Vite e
  // ninguém nunca a consumiu (`grep -rn ADK_SHELL_PORT packages/` devolvia só
  // esta linha). A intenção era o app descobrir a porta do shell em runtime;
  // agora a porta já nasce dentro da allowlist, e uma variável que não é lida
  // por ninguém só sugere um mecanismo que não existe.
  const ambiente = {
    ...envMinimo(ctx.env),
    // O chokidar do Vite lê esta variável; é o `--poll` chegando ao HMR.
    ...(poll ? { CHOKIDAR_USEPOLLING: 'true' } : {}),
  };
  const processoApp = spawn(vite, ['--host', HOST_DEV, '--port', String(porta), '--strictPort'], {
    cwd: raiz,
    env: ambiente,
    stdio: 'inherit',
  });
  const processoShell = spawn(
    vite,
    ['--host', HOST_DEV, '--port', String(portaDoShell(porta)), '--strictPort'],
    {
      cwd: raiz,
      env: ambiente,
      stdio: 'inherit',
    },
  );

  ctx.out(`App:   ${appUrl}`);
  ctx.out(`Shell: ${shellUrl}${PASTA_SHELL}/shell.html  ← abra esta`);
  ctx.out('Ctrl-C para sair.');

  // Quem sai PRIMEIRO decide o exit code, e o outro é encerrado em seguida.
  // Amarrar o resolver só ao processo do app devolvia 0 quando o SHELL falhava
  // (porta ocupada com --strictPort): o app era morto por sinal, saía com
  // `codigo === null`, e o `?? 0` transformava a falha real em sucesso.
  return new Promise<number>((resolver) => {
    let resolvido = false;
    const encerrar = (codigo: number): void => {
      processoApp.kill();
      processoShell.kill();
      if (resolvido) return;
      resolvido = true;
      resolver(codigo);
    };

    processoApp.on('exit', (codigo) => encerrar(codigo ?? 0));
    processoShell.on('exit', (codigo) => encerrar(codigo ?? 0));
    processoApp.on('error', (erro) => {
      ctx.err(`Falha ao subir o Vite: ${erro.message}`);
      encerrar(1);
    });
    processoShell.on('error', (erro) => {
      ctx.err(`Falha ao subir o shell Vite: ${erro.message}`);
      encerrar(1);
    });
  });
}

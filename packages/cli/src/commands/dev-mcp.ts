/**
 * `adk dev` para `kind: mcp` — sobe o servidor do satélite (FastMCP ou Node) e o
 * reinicia a cada save.
 *
 * O ramo de `mcp` caía no mesmo código do `tool`, que carrega `tools/*.py` pelo
 * glob e chama `handler(...)`. O `adk init mcp` não cria `tools/` — gera
 * `server.py` na raiz —, então o glob vinha vazio e a CLI morria com
 * `IndexError: list index out of range` (issue#2764), num traceback cru de
 * Python vazando pela CLI. Valia para 100% dos componentes `kind: mcp`.
 *
 * O ciclo real de um satélite não é "executar o handler uma vez": é o servidor
 * de pé. Por isso aqui o save REINICIA o processo em vez de reexecutar uma
 * função — e o servidor que cai não derruba o `adk dev`, porque corrigir o
 * erro e salvar de novo é exatamente o que se está fazendo.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { envMinimo } from '../exec.js';
import type { Ctx } from '../ctx.js';

/** O entrypoint Python que o `adk init mcp` gera. */
export const ARQUIVO_SERVIDOR = 'server.py';
/** O entrypoint do satélite Node (`adk init mcp --runtime node`). */
export const ARQUIVO_PACOTE_NODE = 'package.json';

export type RuntimeMcp = 'python' | 'node';

/**
 * Detecção pelo ARTEFATO presente, não por campo novo no manifesto:
 * `server.py` é sempre o caminho Python (zero regressão), mesmo que um
 * `package.json` conviva na mesma pasta por outro motivo.
 */
export function detectarRuntimeMcp(raiz: string): RuntimeMcp | undefined {
  if (existsSync(join(raiz, ARQUIVO_SERVIDOR))) return 'python';
  if (existsSync(join(raiz, ARQUIVO_PACOTE_NODE))) return 'node';
  return undefined;
}

/**
 * O comando do ciclo de dev do satélite.
 *
 * Python: mesmo `uv run` do `adk test`/`build` — o venv do componente é quem
 * tem o `mcp` do `pyproject.toml`. Node: `npm run dev` — o script que o
 * `adk init mcp --runtime node` gera, SEM watcher próprio: quem observa e
 * reinicia é este supervisor (dois watchers na mesma árvore estouram o inotify).
 *
 * Sem `raiz`, o default é o caminho Python de hoje — é o que
 * `test/dev-mcp.test.ts` (`comandoServidorMcp()`, sem argumento) trava.
 */
export function comandoServidorMcp(raiz?: string): { comando: string; args: string[] } {
  if (raiz !== undefined && detectarRuntimeMcp(raiz) === 'node') {
    return { comando: 'npm', args: ['run', 'dev'] };
  }
  return { comando: 'uv', args: ['run', 'python', ARQUIVO_SERVIDOR] };
}

/**
 * O que o satélite lê do ambiente: o próprio token e onde escutar. Sem
 * `MCP_TOKEN` o esqueleto responde 503 (fail-closed) e o autor não chama nem
 * `tools/list` na própria máquina.
 */
const ENV_DO_SATELITE = ['MCP_TOKEN', 'PORT', 'BIND_ADDRESS'] as const;

/**
 * O ambiente do subprocesso do satélite: a allowlist geral (`envMinimo`) mais
 * o repasse NOMINAL de `ENV_DO_SATELITE`. A allowlist não é alargada —
 * `ADK_TOKEN`/`ADK_HUB_URL` são a credencial do HUB e entregá-las ao processo
 * de um satélite de terceiro é o que ela existe para impedir.
 */
function envDoSatelite(ctx: Ctx): NodeJS.ProcessEnv {
  const env = envMinimo(ctx.env);
  for (const nome of ENV_DO_SATELITE) {
    const valor = ctx.env[nome];
    if (valor !== undefined) env[nome] = valor;
  }
  return env;
}

/** Endereço anunciado na linha de "de pé" — os mesmos defaults dos dois esqueletos. */
function enderecoAnunciado(ctx: Ctx): string {
  const host = ctx.env.BIND_ADDRESS?.trim() || '0.0.0.0';
  const porta = ctx.env.PORT?.trim() || '8000';
  return `http://${host}:${porta}`;
}

/**
 * Abaixo disso o servidor não ficou de pé — ele nasceu e morreu.
 *
 * O sinal NÃO pode ser o exit code: um servidor que cai em stdio sai com 0 ao
 * receber EOF, que é exatamente o que acontece quando o `adk dev` roda sem
 * terminal (agente headless, CI, nohup). Medido: `adk dev < /dev/null` deixava
 * zero servidores vivos e não dizia uma palavra, porque 0 é "sucesso".
 */
const VIDA_MINIMA_MS = 2000;

export interface ControleDev {
  /** Reinicia o servidor — chamado a cada save. */
  reiniciar(): void;
  /** Encerra o processo atual, se houver. */
  encerrar(): void;
}

/**
 * Mata o GRUPO de processos (não só `processo`), com fallback pro processo
 * isolado quando não há grupo (ex.: já morreu).
 *
 * `npm run dev` é `npm → sh → tsx → node`: um `processo.kill()` singelo só
 * atinge o `npm`, e o neto que faz `listen()` sobrevive segurando a porta —
 * era exatamente a árvore que o verify de runtime viu com o EADDRINUSE
 * perpétuo. `detached: true` no spawn faz o filho virar líder do seu próprio
 * grupo (pgid === pid), e `kill(-pid, sinal)` mata o grupo inteiro.
 */
function matarGrupo(processo: ChildProcess, sinal: NodeJS.Signals): void {
  if (typeof processo.pid !== 'number') return;
  try {
    process.kill(-processo.pid, sinal);
  } catch {
    processo.kill(sinal);
  }
}

export function supervisor(ctx: Ctx, raiz: string): ControleDev {
  const { comando, args } = comandoServidorMcp(raiz);
  let processo: ChildProcess | undefined;
  // Distingue o `kill()` que O PRÓPRIO supervisor dispara (reiniciar/encerrar,
  // onde o silêncio é correto) de um sinal externo (`kill -9` de fora, item
  // 10): os dois chegam ao handler de `exit` com `codigo === null`.
  let matandoPropositalmente = false;
  // `reiniciar()` só pode subir o próximo processo DEPOIS que o `exit` do
  // anterior chegar — subir antes disso reabre a porta enquanto o processo
  // velho ainda não a liberou (o mesmo EADDRINUSE do verify, só que por
  // corrida em vez de árvore incompleta).
  let aoConfirmarSaida: (() => void) | undefined;

  const subir = (): void => {
    const subidoEm = Date.now();
    processo = spawn(comando, args, {
      cwd: raiz,
      env: envDoSatelite(ctx),
      stdio: 'inherit',
      detached: true,
    });
    const deuPe = setTimeout(() => {
      ctx.out(`  servidor de pé em ${enderecoAnunciado(ctx)} — POST /mcp com Bearer (MCP_TOKEN).`);
    }, VIDA_MINIMA_MS);
    deuPe.unref?.();
    processo.on('error', (erro) => {
      clearTimeout(deuPe);
      ctx.err(`Falha ao subir o servidor (${comando}): ${erro.message}`);
    });
    processo.on('exit', (codigo, sinal) => {
      clearTimeout(deuPe);
      // Sair não encerra o `adk dev`: erro de sintaxe e import faltando são o
      // caso COMUM aqui, e o próximo save é o conserto.
      // O reinício/encerrar do próprio supervisor: silêncio é correto. Vale
      // também quando o processo já saía sozinho (código ≠ null) no instante
      // do `reiniciar()` — senão o próximo nunca sobe.
      if (matandoPropositalmente) {
        matandoPropositalmente = false;
        const proximo = aoConfirmarSaida;
        aoConfirmarSaida = undefined;
        proximo?.(); // só agora a porta está liberada — sobe o próximo
        return;
      }
      if (codigo === null) {
        // Morto por fora (kill -9, OOM killer…): o `adk dev` segue de pé e
        // PRECISA reportar, senão o operador não sabe que o servidor caiu e
        // nem que salvar de novo o reergue.
        ctx.out(
          `  ✗ servidor encerrado por fora (sinal ${sinal ?? 'desconhecido'}) — corrija e salve para reiniciar.`,
        );
        return;
      }
      if (Date.now() - subidoEm < VIDA_MINIMA_MS) {
        ctx.out(
          `  ✗ o servidor encerrou assim que subiu (código ${codigo}) — veja o erro acima, ` +
            'corrija e salve para reiniciar.',
        );
        return;
      }
      ctx.out(`  ✗ servidor saiu com código ${codigo} — corrija e salve para reiniciar.`);
    });
  };

  // Já morreu (por fora, ex.: `kill -9`, item 10) quando `exit` já disparou —
  // Node marca `exitCode`/`signalCode` nesse momento. Nesse caso não há
  // `exit` futuro para esperar: subir direto, sem passar pelo `matarGrupo`.
  const jaTerminou = (p: ChildProcess): boolean => p.exitCode !== null || p.signalCode !== null;

  subir();
  return {
    reiniciar: () => {
      if (!processo || jaTerminou(processo)) {
        subir();
        return;
      }
      matandoPropositalmente = true;
      aoConfirmarSaida = subir;
      matarGrupo(processo, 'SIGKILL');
    },
    encerrar: () => {
      if (!processo || jaTerminou(processo)) return;
      matandoPropositalmente = true;
      aoConfirmarSaida = undefined;
      matarGrupo(processo, 'SIGKILL');
    },
  };
}

/** Código de saída convencional de quem morre por sinal: 128 + número do sinal. */
const SAIDA_POR_SINAL = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

/**
 * Amarra a vida do satélite à do `adk dev`.
 *
 * O satélite é `detached` (líder do PRÓPRIO grupo) para o reinício matar a
 * árvore `npm → sh → tsx → node` inteira — e por isso o Ctrl-C do terminal e
 * o SIGTERM do orquestrador, que vão ao grupo do `adk dev`, não chegam a ele.
 * Sem isto o `adk dev` morre e o satélite fica órfão segurando a porta.
 * `encerrar()` é síncrono (`kill` do grupo), então também vale no `exit`.
 */
export function encerrarJuntoComOProcesso(servidor: ControleDev): void {
  process.once('exit', () => servidor.encerrar());
  for (const [sinal, codigo] of Object.entries(SAIDA_POR_SINAL)) {
    process.once(sinal, () => {
      servidor.encerrar();
      process.exit(codigo);
    });
  }
}

/** Pré-condição do ramo `mcp`: sem nenhum dos dois entrypoints não há o que subir. */
export function faltaServidor(raiz: string): boolean {
  return detectarRuntimeMcp(raiz) === undefined;
}

export function erroSemServidor(ctx: Ctx, raiz: string): number {
  ctx.err(
    `Não encontrei ${ARQUIVO_SERVIDOR} nem ${ARQUIVO_PACOTE_NODE} em ${raiz} — \`kind: mcp\` sobe ` +
      `o servidor FastMCP (Python, \`${ARQUIVO_SERVIDOR}\`) ou o satélite Node (\`${ARQUIVO_PACOTE_NODE}\` ` +
      '+ `src/server.ts`) — é o que o `adk init mcp`/`adk init mcp --runtime node` gera. ' +
      'Crie um dos dois ou rode o `adk dev` na pasta certa.',
  );
  return 2;
}

/** Pré-condição do satélite Node: sem `node_modules/`, o `npm run dev` não tem o que rodar. */
export function faltamDependenciasNode(raiz: string): boolean {
  return detectarRuntimeMcp(raiz) === 'node' && !existsSync(join(raiz, 'node_modules'));
}

export function erroDependenciasNode(ctx: Ctx, raiz: string): number {
  ctx.err(
    `node_modules não encontrado em ${raiz} — rode \`npm install\` na pasta do componente antes do \`adk dev\`.`,
  );
  return 2;
}

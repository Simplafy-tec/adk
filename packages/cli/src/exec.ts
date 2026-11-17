/** Execução de processo externo — nunca lança: o `doctor` reporta a falta como diagnóstico. */

import { execFile } from 'node:child_process';
import type { Ctx } from './ctx.js';

export interface Execucao {
  ok: boolean;
  saida: string;
  codigo: number | null;
}

/**
 * Só o que o runtime precisa atravessa para o subprocesso.
 *
 * `uv lock`, `ruff` e `pytest` rodam sobre código de TERCEIRO — passar o
 * ambiente inteiro entregaria `ADK_TOKEN` (a credencial do Hub) a qualquer
 * `conftest.py` ou hook de build do componente. Allowlist em vez de blocklist:
 * variável nova de segredo nasce bloqueada, não esquecida.
 */
const PREFIXOS_PERMITIDOS = ['UV_', 'PYTHON', 'LC_', 'XDG_'];
const NOMES_PERMITIDOS = [
  'PATH',
  'HOME',
  'VIRTUAL_ENV',
  'LANG',
  'TMPDIR',
  'TZ',
  'TERM',
  // Sessão gráfica: sem elas o `xdg-open`/`open` do `adk login` não acha o
  // navegador do operador. Não são segredo, e o login ficaria manual sem isso.
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'BROWSER',
];

export function envMinimo(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const saida: NodeJS.ProcessEnv = {};
  for (const [chave, valor] of Object.entries(env)) {
    if (valor === undefined) continue;
    if (NOMES_PERMITIDOS.includes(chave) || PREFIXOS_PERMITIDOS.some((p) => chave.startsWith(p))) {
      saida[chave] = valor;
    }
  }
  return saida;
}

export interface OpcoesExecucao {
  cwd?: string;
  timeoutMs?: number;
  /**
   * Variáveis que atravessam ALÉM da allowlist, quando definidas — para a
   * ferramenta que não funciona sem elas (o `docker` precisa do endereço e do
   * contexto do daemon). Nome a nome, nunca prefixo: o resto do ambiente
   * continua bloqueado.
   */
  variaveisExtras?: readonly string[];
  /** Teto da saída acumulada (o default do Node, 1 MiB, mata um `docker build` verboso). */
  maxBufferBytes?: number;
}

export function executar(
  ctx: Ctx,
  comando: string,
  args: readonly string[],
  opcoes: OpcoesExecucao = {},
): Promise<Execucao> {
  const env = envMinimo(ctx.env);
  for (const nome of opcoes.variaveisExtras ?? []) {
    const valor = ctx.env[nome];
    if (valor !== undefined) env[nome] = valor;
  }
  return new Promise((resolver) => {
    execFile(
      comando,
      [...args],
      {
        cwd: opcoes.cwd ?? ctx.cwd,
        env,
        timeout: opcoes.timeoutMs ?? 120_000,
        ...(opcoes.maxBufferBytes === undefined ? {} : { maxBuffer: opcoes.maxBufferBytes }),
      },
      (erro, stdout, stderr) => {
        const saida = `${stdout ?? ''}${stderr ?? ''}`.trim();
        resolver({
          ok: !erro,
          saida: erro && !saida ? erro.message : saida,
          codigo: erro
            ? (((erro as NodeJS.ErrnoException & { code?: number }).code ?? 1) as number)
            : 0,
        });
      },
    );
  });
}

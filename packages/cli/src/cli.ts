/**
 * `adk` — a CLI do ADK.
 *
 * `runCli` devolve `{exitCode, stdout, stderr}` em vez de matar o processo: é o
 * que permite testar a CLI inteira em processo (com o Hub mockado) e, mais
 * importante, é o que deixa um artefato com erro NÃO abortar os demais no
 * `deploy` — a CLI antiga chamava `process.exit` no primeiro 4xx.
 */

import { Command } from 'commander';
import { comandoBuild, comandoTest } from './commands/build.js';
import { comandoDev } from './commands/dev.js';
import { comandoPlanOuDeploy, comandoValidate } from './commands/deploy.js';
import { comandoDoctor } from './commands/doctor.js';
import { comandoInit, type KindInit } from './commands/init.js';
import { comandoInitOrg } from './commands/init-org.js';
import { comandoLogin, comandoLogout, comandoOrgs, comandoWhoami } from './commands/login.js';
import { comandoExport } from './commands/export.js';
import { comandoMcpServer } from './commands/mcp-server.js';
import { comandoPublish } from './commands/publish.js';
import { comandoStatus } from './commands/status.js';
import { versaoDaCli } from './versao.js';
import {
  conflitoPerfilHost,
  perfilDeclarado,
  PerfilDesconhecidoError,
  type CliResult,
  type Ctx,
  type Entrada,
} from './ctx.js';

export interface RunCliOptions {
  cwd?: string;
  /** Sobrescreve variáveis de ambiente (mesclado sobre `process.env`). */
  env?: Record<string, string | undefined>;
  /** Escreve direto no terminal em vez de acumular (uso real do binário). */
  stream?: boolean;
  /**
   * De onde a CLI lê respostas (confirmação de apply em produção, escolha de
   * org no `init org`). É terminal só com `isTTY === true`. Default:
   * `process.stdin`.
   */
  stdin?: Entrada;
}

export async function runCli(argv: string[], opcoes: RunCliOptions = {}): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx: Ctx = {
    cwd: opcoes.cwd ?? process.cwd(),
    env: { ...process.env, ...opcoes.env },
    stdin: opcoes.stdin ?? process.stdin,
    out: (linha) => {
      if (opcoes.stream) process.stdout.write(`${linha}\n`);
      else stdout.push(linha);
    },
    err: (linha) => {
      if (opcoes.stream) process.stderr.write(`${linha}\n`);
      else stderr.push(linha);
    },
  };

  let exitCode = 0;
  const executar = (acao: (ctx: Ctx) => number | Promise<number>) => async () => {
    exitCode = await acao(ctx);
  };

  const program = new Command();
  program
    .name('adk')
    .description('CLI do ADK da Simplafy — configuração declarativa de agentes, tools e jornadas.')
    .version(versaoDaCli())
    .exitOverride()
    .configureOutput({
      writeOut: (s) => ctx.out(s.replace(/\n$/, '')),
      writeErr: (s) => ctx.err(s.replace(/\n$/, '')),
    })
    .option(
      '--profile <perfil>',
      'ambiente do Hub: prod | staging (default: ADK_PROFILE, senão prod)',
    )
    // Perfil inválido, ou que contradiz o host conhecido de ADK_HUB_URL, é
    // pré-condição de qualquer comando: recusado antes da ação, para nenhum
    // deles cair em silêncio no perfil padrão ou falar com o Hub do outro
    // ambiente.
    .hook('preAction', (_raiz, comando) => {
      ctx.profile = program.opts<{ profile?: string }>().profile;
      try {
        perfilDeclarado(ctx);
      } catch (e) {
        if (!(e instanceof PerfilDesconhecidoError)) throw e;
        comando.error(e.message, { exitCode: 2, code: 'adk.perfilDesconhecido' });
      }
      const conflito = conflitoPerfilHost(ctx);
      if (conflito) comando.error(conflito, { exitCode: 2, code: 'adk.perfilContradizHost' });
    });

  program
    .command('doctor')
    .description('Confere a máquina contra a política da plataforma.')
    .action(executar((c) => comandoDoctor(c)));

  program
    .command('login')
    .option(
      '--org <id>',
      'pede o consentimento só desta organização (default: todas em que você é ADMIN)',
    )
    .description('Autoriza esta máquina no Hub (OAuth + PKCE).')
    .action(async (opts: { org?: string }) => {
      exitCode = await comandoLogin(ctx, opts);
    });
  program
    .command('logout')
    .description('Revoga e apaga a credencial deste Hub.')
    .action(executar(comandoLogout));
  program
    .command('whoami')
    .description('Quem está autenticado neste Hub.')
    .action(executar(comandoWhoami));
  program
    .command('orgs')
    .description('Organizações do token, com o papel em cada uma.')
    .action(executar(comandoOrgs));

  program
    .command('init')
    .argument('<kind>', 'tool | mcp | app | team | org')
    .argument('[nome]', 'nome do componente; em `init org`, o da pasta (default: o da org)')
    .option(
      '--dir <caminho>',
      'tool/mcp/app: RAIZ do componente (default: ./<slug>); org: raiz do repositório de clientes (default: .)',
    )
    .option('--org <id>', 'org: id da organização (default: escolher entre as do token)')
    .option('--env <ambiente>', 'org: ambiente declarado no org.yaml (default: o do perfil)')
    .option('--runtime <runtime>', 'mcp: runtime do satélite — python (default) ou node', 'python')
    .description('Cria o esqueleto de um componente, ou a pasta de uma org que já existe no Hub.')
    .action(
      async (
        kind: string,
        nome: string | undefined,
        opts: { dir?: string; org?: string; env?: string; runtime?: string },
      ) => {
        if (kind === 'org') {
          exitCode = await comandoInitOrg(ctx, {
            dir: opts.dir,
            org: opts.org,
            env: opts.env,
            pasta: nome,
          });
          return;
        }
        if (kind !== 'tool' && kind !== 'mcp' && kind !== 'app' && kind !== 'team') {
          ctx.err(`Kind desconhecido: ${kind} — use tool, mcp, app, team ou org.`);
          exitCode = 2;
          return;
        }
        const runtime = opts.runtime ?? 'python';
        if (runtime !== 'python' && runtime !== 'node') {
          ctx.err(`Runtime desconhecido: ${runtime} — use python ou node.`);
          exitCode = 2;
          return;
        }
        if (runtime === 'node' && kind !== 'mcp') {
          ctx.err(`--runtime node só é aceito com kind: mcp — kind: ${kind} tem um runtime só.`);
          exitCode = 2;
          return;
        }
        if (!nome) {
          ctx.err(`Informe o nome: adk init ${kind} <nome>.`);
          exitCode = 2;
          return;
        }
        exitCode = comandoInit(ctx, kind as KindInit, nome, { dir: opts.dir, runtime });
      },
    );

  program
    .command('build')
    .option('--dir <caminho>')
    .description(
      'Contrato + vazamento + uv lock + ruff + política (ou, num pacote de time com team.yaml, contrato + vazamento + arquivos das peças).',
    )
    .action(async (opts: { dir?: string }) => {
      exitCode = await comandoBuild(ctx, opts);
    });

  program
    .command('test')
    .option('--dir <caminho>')
    .description('Roda a suíte do componente (uv run pytest; npm test no satélite Node).')
    .action(async (opts: { dir?: string }) => {
      exitCode = await comandoTest(ctx, opts);
    });

  program
    .command('dev')
    .option('--dir <caminho>')
    // Só a porta é configurável: o host é sempre 127.0.0.1.
    .option('--port <porta>', 'porta do Vite/shell em 127.0.0.1 (kind: app)', (v) => Number(v))
    // Saída sem privilégio quando o inotify do sistema acabou (issue#2772).
    .option('--poll', 'observa por polling de mtime, sem inotify')
    .description('Revalida e executa o handler a cada save; para `kind: app`, Vite + Hub shell.')
    .action(async (opts: { dir?: string; port?: number; poll?: boolean }) => {
      exitCode = await comandoDev(ctx, opts);
    });

  // ADR-121 §11.3 — `status` e `export` são comandos de v1 que nunca existiram
  // (issue#2773). Sem `status`, a pendência que o produto cria por desenho só
  // existia na tela; sem `export`, adotar uma org que já está no ar significava
  // redigitar à mão o que o Hub já sabe.
  program
    .command('status')
    .requiredOption('--org <id>', 'id da organização no ambiente')
    .option('--kind <kind>', 'filtra por kind (agent|tool|journey|table|mcp|app)')
    .option('--json')
    .description('Lista as pendências ABERTAS da organização.')
    .action(async (opts: { org?: string; kind?: string; json?: boolean }) => {
      exitCode = await comandoStatus(ctx, opts);
    });

  program
    .command('export')
    .requiredOption('--org <id>', 'id da organização no ambiente')
    .option('--env <ambiente>', 'ambiente do org.yaml (default: o do perfil)')
    .option('--dir <caminho>', 'raiz do repositório de clientes (default: .)')
    .option('--kind <kind>', 'exporta só um kind (agent|tool|journey)')
    .option('--json')
    .description('Traz do Hub, na forma declarativa, o que já existe na organização.')
    .action(
      async (opts: { org?: string; env?: string; dir?: string; kind?: string; json?: boolean }) => {
        exitCode = await comandoExport(ctx, opts);
      },
    );

  program
    .command('validate')
    .option('--org <id>', 'valida só a pasta desta organização (o mesmo id do plan/apply)')
    .option('--env <ambiente>', 'ambiente do org.yaml para casar o --org (default: o do perfil)')
    .option('--dir <caminho>')
    .option('--json')
    .description('Valida os artefatos localmente, sem falar com o Hub.')
    .action(async (opts: { dir?: string; json?: boolean; org?: string; env?: string }) => {
      exitCode = await comandoValidate(ctx, opts);
    });

  for (const nome of ['plan', 'deploy', 'apply'] as const) {
    const comando = program
      .command(nome)
      .requiredOption('--org <id>', 'id da organização no ambiente')
      // Sem default fixo: o ambiente vem do perfil, e `--env` só confirma.
      .option(
        '--env <ambiente>',
        'ambiente declarado em orgs/*/org.yaml (default: o do perfil — prod → production)',
      )
      .option('--dir <caminho>')
      .option('--json');
    if (nome !== 'plan') {
      comando.option(
        '--yes',
        'pula a confirmação de apply em produção (obrigatório fora de terminal, ex.: CI)',
      );
    }
    comando
      .description(
        nome === 'plan'
          ? 'Mostra o que mudaria na organização, sem gravar.'
          : 'Aplica todos os artefatos da organização (tool → agent → journey).',
      )
      .action(
        async (opts: {
          org: string;
          env?: string;
          dir?: string;
          json?: boolean;
          yes?: boolean;
        }) => {
          exitCode = await comandoPlanOuDeploy(ctx, nome === 'plan' ? 'plan' : 'apply', opts);
        },
      );
  }

  program
    .command('publish')
    .option('--dir <caminho>', 'raiz do componente kind: mcp (default: .)')
    .option(
      '--registry <url>',
      'registry de destino (default: ADK_REGISTRY_URL, senão https://registry.simplafy.com.br)',
    )
    .option(
      '--platform <plataforma>',
      'plataforma da imagem (default: linux/amd64, a dos nós do cluster)',
    )
    .description('Constrói a imagem do satélite, empurra com o token do Hub e grava o digest.')
    .action(async (opts: { dir?: string; registry?: string; platform?: string }) => {
      exitCode = await comandoPublish(ctx, opts);
    });

  program
    .command('mcp-server')
    .description('Expõe o contrato do ADK a um cliente MCP (stdio).')
    .action(async () => {
      exitCode = await comandoMcpServer(ctx);
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (e) {
    const erro = e as { code?: string; exitCode?: number; message?: string };
    // `--help`/`--version` chegam aqui pelo exitOverride: são saída normal.
    if (erro.code === 'commander.helpDisplayed' || erro.code === 'commander.version') {
      exitCode = 0;
    } else if (typeof erro.exitCode === 'number') {
      exitCode = erro.exitCode;
    } else {
      ctx.err(erro.message ?? String(e));
      exitCode = 1;
    }
  }

  return { exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

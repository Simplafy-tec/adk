/**
 * Contexto de execução de um comando.
 *
 * `cwd`, `env` e a saída são INJETADOS em vez de lidos de `process` direto: é o
 * que permite ao teste rodar a CLI inteira em processo, com o Hub mockado, sem
 * spawn e sem tocar o terminal — e é o que faz `runCli` devolver um código de
 * saída em vez de matar o processo no meio de um loop de artefatos.
 */

export interface Ctx {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Valor de `--profile`; ganha de `ADK_PROFILE` (ver `perfilDeclarado`). */
  profile?: string;
  /**
   * Entrada de onde a CLI lê respostas (confirmação de apply, escolha de org).
   * Só é tratada como terminal quando `isTTY === true`; ausente, não há como
   * perguntar — o comando se comporta como fora de TTY.
   */
  stdin?: Entrada;
  /** Uma linha na saída padrão. */
  out(linha: string): void;
  /** Uma linha na saída de erro — diagnóstico nunca polui o `--json`. */
  err(linha: string): void;
}

/** Stream de leitura com a marca de terminal do Node (`process.stdin` serve). */
export type Entrada = NodeJS.ReadableStream & { isTTY?: boolean };

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Perfis de ambiente embutidos: quem só tem conta de produção não configura URL nenhuma. */
export type Perfil = 'prod' | 'staging';

/** Ambiente declarado em `orgs/<pasta>/org.yaml` (`environments.<ambiente>`). */
export type Ambiente = 'production' | 'staging';

interface DefinicaoPerfil {
  hub: string;
  auth: string;
  ambiente: Ambiente;
}

const PERFIS: Readonly<Record<Perfil, DefinicaoPerfil>> = {
  prod: {
    hub: 'https://api-hub-v2.simplafy.com.br',
    auth: 'https://app.simplafy.com.br/hub',
    ambiente: 'production',
  },
  staging: {
    hub: 'https://api-hub-v2-staging.simplafy.com.br',
    auth: 'https://app-staging.simplafy.com.br/hub',
    ambiente: 'staging',
  },
};

const PERFIL_PADRAO: Perfil = 'prod';

export class PerfilDesconhecidoError extends Error {
  constructor(valor: string) {
    super(`Perfil desconhecido: "${valor}" — use ${Object.keys(PERFIS).join(' | ')}.`);
    this.name = 'PerfilDesconhecidoError';
  }
}

/**
 * Perfil pedido explicitamente: `--profile` ganha de `ADK_PROFILE`. `null`
 * quando nenhum dos dois foi informado — é o que distingue "prod por padrão"
 * de "prod escolhido", e só o segundo vale junto de um `ADK_HUB_URL`.
 */
export function perfilDeclarado(ctx: Ctx): Perfil | null {
  const bruto = (ctx.profile ?? ctx.env.ADK_PROFILE)?.trim();
  if (!bruto) return null;
  if (!(bruto in PERFIS)) throw new PerfilDesconhecidoError(bruto);
  return bruto as Perfil;
}

function perfilEfetivo(ctx: Ctx): Perfil {
  return perfilDeclarado(ctx) ?? PERFIL_PADRAO;
}

function hubOverride(ctx: Ctx): string | null {
  const bruto = ctx.env.ADK_HUB_URL?.trim();
  return bruto ? semBarraFinal(bruto) : null;
}

function semBarraFinal(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Base da API do Hub, sem barra final: `ADK_HUB_URL` > perfil > prod. */
export function hubUrl(ctx: Ctx): string {
  return hubOverride(ctx) ?? PERFIS[perfilEfetivo(ctx)].hub;
}

/**
 * Base do servidor de autorização OAuth (`/api/oauth/*`), sem barra final.
 *
 * NÃO é a mesma origem da API em staging nem em produção. Medido em staging
 * (2026-09-01):
 *
 *   api-hub-v2-staging.simplafy.com.br   GET /api/v1/adk/policy   200
 *                                        POST /api/oauth/register 404
 *   app-staging.simplafy.com.br/hub      POST /api/oauth/register 201
 *                                        GET /api/v1/adk/policy   404
 *
 * O AS é servido pelo `apps/web` (Next.js, `basePath: '/hub'`) e as rotas do
 * ADK pelo `apps/api` (NestJS), em hosts diferentes. Ordem de resolução:
 *
 *   1. `ADK_AUTH_URL`, quando definida — override explícito;
 *   2. com `ADK_HUB_URL`, o AS derivado dele quando é um host conhecido da API
 *      (o de um perfil embutido), senão o próprio Hub — quem serve tudo na mesma
 *      origem (dev local) não configura mais nada;
 *   3. o AS do perfil.
 */
export function authUrl(ctx: Ctx): string {
  const bruto = ctx.env.ADK_AUTH_URL?.trim();
  if (bruto) return semBarraFinal(bruto);
  const hub = hubOverride(ctx);
  if (hub) return derivarAs(hub) ?? hub;
  return PERFIS[perfilEfetivo(ctx)].auth;
}

export type AmbienteResolvido = { ok: true; ambiente: string } | { ok: false; erro: string };

/**
 * Ambiente que o host de `ADK_HUB_URL` diz sozinho, quando é a API de um dos
 * perfis embutidos. O roteiro interno de QA exporta só
 * `ADK_HUB_URL=https://api-hub-v2-staging…`: sem esta dedução, o perfil `prod`
 * padrão escolheria a pasta de PRODUÇÃO e a mandaria ao Hub de staging.
 */
export function ambienteDoHost(ctx: Ctx): Ambiente | null {
  const hub = hubOverride(ctx);
  const perfil = hub ? perfilDoHost(hub) : null;
  return perfil ? PERFIS[perfil].ambiente : null;
}

/** Perfil embutido cuja API mora no host desta URL. */
function perfilDoHost(url: string): Perfil | null {
  const host = hostDe(url);
  if (!host) return null;
  return (Object.keys(PERFIS) as Perfil[]).find((p) => hostDe(PERFIS[p].hub) === host) ?? null;
}

function hostDe(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    // `ADK_HUB_URL` que não é URL não tem host: não deduz ambiente nenhum.
    return null;
  }
}

/**
 * Perfil declarado que contradiz o host conhecido de `ADK_HUB_URL`. É
 * pré-condição de QUALQUER comando (inclusive `login`): o perfil escolheria o
 * AS e a pasta de um ambiente, e o host mandaria a chamada ao outro.
 */
export function conflitoPerfilHost(ctx: Ctx): string | null {
  const doHost = ambienteDoHost(ctx);
  const declarado = perfilDeclarado(ctx);
  if (!doHost || !declarado || PERFIS[declarado].ambiente === doHost) return null;
  return (
    `O perfil ${declarado} contradiz ADK_HUB_URL (${hubOverride(ctx)}, ambiente ${doHost}): ` +
    'remova ADK_HUB_URL ou use o perfil do mesmo ambiente.'
  );
}

/**
 * O `--env` de `plan`/`apply`/`export`, conferido contra o host e o perfil.
 *
 * O ambiente decide qual id de `org.yaml` vale, e o host decide em qual Hub a
 * chamada chega: os dois discordando mandaria a configuração de um ambiente
 * para o Hub do outro. Por isso `--env` divergente é recusado, não corrigido.
 * Ordem: host conhecido de `ADK_HUB_URL` > perfil > `prod`. Com `ADK_HUB_URL`
 * de host desconhecido e sem perfil, `--env` é obrigatório (ou cai em
 * `semPerfil`, quando o comando tem um padrão próprio).
 */
export function resolverAmbiente(
  ctx: Ctx,
  envInformado: string | undefined,
  semPerfil?: Ambiente,
): AmbienteResolvido {
  const conflito = conflitoPerfilHost(ctx);
  if (conflito) return { ok: false, erro: conflito };

  const doHost = ambienteDoHost(ctx);
  if (doHost) {
    if (envInformado === undefined || envInformado === doHost)
      return { ok: true, ambiente: doHost };
    return {
      ok: false,
      erro: `--env ${envInformado} diverge de ADK_HUB_URL (${hubOverride(ctx)}, ambiente ${doHost}): omita --env ou aponte ADK_HUB_URL para o Hub de ${envInformado}.`,
    };
  }

  const declarado = perfilDeclarado(ctx);
  const perfil = declarado ?? (hubOverride(ctx) ? null : PERFIL_PADRAO);
  if (!perfil) {
    const ambiente = envInformado ?? semPerfil;
    if (ambiente) return { ok: true, ambiente };
    return {
      ok: false,
      erro: 'Informe --env <production|staging>: com ADK_HUB_URL de host desconhecido e sem --profile/ADK_PROFILE o ambiente não é deduzido.',
    };
  }
  const esperado = PERFIS[perfil].ambiente;
  if (envInformado === undefined || envInformado === esperado) {
    return { ok: true, ambiente: esperado };
  }
  const outro = (Object.keys(PERFIS) as Perfil[]).find((p) => PERFIS[p].ambiente === envInformado);
  const dica = outro
    ? `use --profile ${outro} (ou ADK_PROFILE=${outro}) para ${envInformado}`
    : `os ambientes são ${Object.values(PERFIS)
        .map((d) => d.ambiente)
        .join(' | ')}`;
  return {
    ok: false,
    erro: `--env ${envInformado} diverge do perfil ${perfil} (ambiente ${esperado}): omita --env ou ${dica}.`,
  };
}

/**
 * AS (`apps/web`) do mesmo ambiente da API de `ADK_HUB_URL`, quando o host é o
 * de um perfil embutido. `api[-staging]` é a API do Saúde, não do Hub: fica de
 * fora e cai no próprio Hub.
 */
function derivarAs(hub: string): string | null {
  const perfil = perfilDoHost(hub);
  return perfil ? PERFIS[perfil].auth : null;
}

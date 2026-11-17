/**
 * Cliente HTTP do Hub — as rotas do ADK e a política.
 *
 * O YAML viaja CRU até o Hub: o parse e os portões vivem lá também (o pacote
 * `@simpla.fy/adk-contract` é o MESMO motor dos dois lados). Interpretar o
 * arquivo aqui e mandar outra coisa criaria duas verdades sobre o que o
 * arquivo significa.
 */

import { DEFAULT_POLICY, PolicySchema, type Policy } from '@simpla.fy/adk-contract';
import { claimsDoToken, refreshTokens } from './auth.js';
import { loadCredentials, saveCredentials } from './credentials.js';
import { authUrl, hubUrl, type Ctx } from './ctx.js';

/** Resposta de `POST /api/v1/adk/{kind}/{plan|apply}` (ApplyResult do Hub). */
export interface Plano {
  slug?: string;
  action?: string;
  changes?: { field: string; from?: unknown; to?: unknown }[];
  collaborators?: { agent: string; action: string }[];
  /** Vínculos agente↔tool do plano (`create`/`update`/`remove`/`noop`/`unmanaged`). */
  toolBindings?: VinculoDoPlano[];
  /** Revogações declaradas (`tools_remover`), inclusive `noop` — é o eco do campo. */
  toolRevocations?: RevogacaoDoPlano[];
  /** Eco das áreas do Agent Control, quando o arquivo declara `agent_control`. */
  agentControl?: { action: string; from?: Record<string, string>; to: Record<string, string> };
  /** Eco de `definition.crmAlcance`, quando declarado. */
  crmAlcance?: { from: string; to: string };
  blocking?: { code: string; path: string; message: string }[];
  pending?: { field: string; slug: string; reason: string }[];
}

export interface VinculoDoPlano {
  name: string;
  action: string;
  /** Eco do Alcance quando o vínculo o declara; `from` ausente = vínculo novo. */
  alcance?: { from?: string; to: string };
}

export interface RevogacaoDoPlano {
  name: string;
  /** Nome declarado no arquivo, quando difere de `name` (integração por nome). */
  declared?: string;
  action: string;
}

export interface ApplyResult {
  plan?: Plano;
  applied?: boolean;
  error?: { path?: string; message: string };
}

/** Renova 60 s antes do fim: um token que expira no meio do deploy vira 401 no artefato do meio. */
const MARGEM_MS = 60_000;

/**
 * Token de acesso para as rotas do ADK.
 *
 * `ADK_TOKEN` ganha do login: é o caminho headless (API key da org ou JWT de
 * CI) e precisa ser previsível — se o login local sobrescrevesse, o CI passaria
 * a usar a credencial da máquina de quem rodou por último.
 */
export async function accessToken(ctx: Ctx): Promise<string | null> {
  const doAmbiente = ctx.env.ADK_TOKEN?.trim();
  if (doAmbiente) return doAmbiente;

  const base = hubUrl(ctx);
  const loc = { hubUrl: base, configDir: ctx.env.ADK_CONFIG_DIR };
  const creds = await loadCredentials(loc);
  if (!creds) return null;
  if (creds.expires_at - MARGEM_MS > Date.now()) return creds.access_token;

  const novo = await refreshTokens({
    // O refresh vai para o AS (mesma origem que emitiu), não para a API.
    hubUrl: authUrl(ctx),
    clientId: creds.client_id,
    refreshToken: creds.refresh_token,
  });
  const atualizado = {
    ...creds,
    access_token: novo.access_token,
    // Rotation: o refresh antigo morre na troca. Guardar o novo é o que evita
    // exigir login de novo a cada 15 minutos.
    refresh_token: novo.refresh_token ?? creds.refresh_token,
    expires_at: Date.now() + (novo.expires_in ?? 900) * 1000,
    user: claimsDoToken(novo.access_token).email ?? creds.user,
  };
  await saveCredentials(loc, atualizado);
  return atualizado.access_token;
}

export interface ChamadaAdk {
  /** `tools` | `agents` | `journeys`. */
  rota: string;
  /** `plan` | `apply`. */
  operacao: 'plan' | 'apply';
  orgId: string;
  yaml: string;
  prompt?: string;
  /**
   * issue#2500 — pacote da tool `runtime: script` (`{files, lock, hash}`).
   * Só o `apply` o envia; o `plan` não precisa do código para diferenciar.
   */
  bundle?: { files: Record<string, string>; lock: string; hash: string };
}

/**
 * GET autenticado numa rota de leitura do ADK (`pendencies`, `<kind>/export`).
 *
 * Mesmo contrato do `chamarAdk`: a organização vai na QUERY, porque é de lá
 * que a API a lê e o guard de papel a revalida — mandá-la só no header faria a
 * API cair na org do token e o `--org` virar decoração.
 */
export async function buscarAdk<T>(
  ctx: Ctx,
  rota: string,
  params: Record<string, string> = {},
): Promise<T> {
  const base = hubUrl(ctx);
  const token = await accessToken(ctx);
  if (!token) throw new Error('Sem credencial: rode `adk login` ou defina ADK_TOKEN.');

  const query = new URLSearchParams(params).toString();
  const r = await fetch(`${base}/api/v1/adk/${rota}${query ? `?${query}` : ''}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const texto = await r.text();
  if (!r.ok) {
    let mensagem = texto;
    try {
      mensagem = (JSON.parse(texto) as { message?: string }).message ?? texto;
    } catch {
      /* corpo não-JSON: o texto cru já é a melhor mensagem */
    }
    throw new Error(`Hub recusou (${r.status}): ${mensagem}`);
  }
  return JSON.parse(texto) as T;
}

export async function chamarAdk(ctx: Ctx, chamada: ChamadaAdk): Promise<ApplyResult> {
  const base = hubUrl(ctx);
  const token = await accessToken(ctx);
  if (!token) {
    throw new Error('Sem credencial: rode `adk login` ou defina ADK_TOKEN.');
  }

  // A organização vai na QUERY porque é de lá que a API a lê, e o guard de
  // papel a revalida (403 para org sem vínculo). Mandá-la só num header era
  // silencioso do pior jeito: a API caía na org do token e o `--org` virava
  // decoração — o plano saía correto para o tenant errado.
  const url = `${base}/api/v1/adk/${chamada.rota}/${chamada.operacao}?orgId=${encodeURIComponent(chamada.orgId)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      yaml: chamada.yaml,
      ...(chamada.prompt === undefined ? {} : { prompt: chamada.prompt }),
      // issue#2500 — pacote da tool `runtime: script`. O Hub EXIGE artefato
      // para esse runtime (`adk.service.ts`: sem ele o worker não teria
      // `{entry, handler}` nem código) e reconfere o hash. Ausente para todo
      // artefato sem pacote — mandar `bundle: undefined` é o mesmo que omitir.
      ...(chamada.bundle === undefined ? {} : { bundle: chamada.bundle }),
    }),
  });
  const texto = await r.text();
  let corpo: ApplyResult & { message?: string };
  try {
    corpo = JSON.parse(texto) as ApplyResult;
  } catch {
    // Corpo ilegível é informação: mostrar o texto cru diz mais do que "erro
    // desconhecido" quando um proxy responde HTML no meio do caminho.
    throw new Error(`Hub respondeu ${r.status} com corpo não-JSON:\n${texto.slice(0, 400)}`);
  }
  if (!r.ok) throw new Error(`Hub recusou (${r.status}): ${corpo?.message ?? texto}`);
  return corpo;
}

export interface PoliticaCarregada {
  policy: Policy;
  origem: 'hub' | 'embutida';
  detalhe?: string;
}

/**
 * `GET /api/v1/adk/policy` — público e cacheável. Enquanto a rota não existir
 * (parte 2 desta fatia), ou quando o Hub estiver fora, cai para a política
 * embutida: um `doctor` mudo por indisponibilidade do produto trocaria o
 * diagnóstico por silêncio justamente na hora em que ele é útil.
 */
export async function carregarPolitica(ctx: Ctx): Promise<PoliticaCarregada> {
  const base = hubUrl(ctx);
  try {
    const r = await fetch(`${base}/api/v1/adk/policy`);
    if (!r.ok) {
      return { policy: DEFAULT_POLICY, origem: 'embutida', detalhe: `o Hub respondeu ${r.status}` };
    }
    const analisada = PolicySchema.safeParse(await r.json());
    if (!analisada.success) {
      return {
        policy: DEFAULT_POLICY,
        origem: 'embutida',
        detalhe: 'o Hub devolveu uma política fora do contrato',
      };
    }
    return { policy: analisada.data, origem: 'hub' };
  } catch (e) {
    return { policy: DEFAULT_POLICY, origem: 'embutida', detalhe: (e as Error).message };
  }
}

/**
 * O plano, venha ele no envelope do `apply` ou cru do `plan`.
 *
 * `apply` responde `{plan, applied}`; `plan` responde o plano no TOPO. Ler só
 * `resposta.plan` fazia o `plan` cair sempre em objeto vazio — `action: null` —
 * e a impressão rotulava TUDO como mudança, inclusive o `noop`. Medido em
 * staging (issue#2500): depois de um deploy bem-sucedido, o `plan` seguinte
 * dizia "atualizar" enquanto a API respondia
 * `{"action":"noop","changes":[],"drift":{"drifted":false}}`.
 */
export function planoDaResposta(resposta: ApplyResult): Plano {
  const envelope = (resposta as { plan?: Plano }).plan;
  if (envelope && typeof envelope === 'object') return envelope;
  const cru = resposta as unknown as Plano;
  return cru && typeof cru.action === 'string' ? cru : {};
}

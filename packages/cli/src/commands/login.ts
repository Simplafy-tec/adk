/**
 * `adk login | whoami | orgs | logout`.
 *
 * O token do ADK sai com `aud: 'adk'` (parte 2 desta fatia, no AS do Hub) e
 * vale SÓ nas rotas `/api/v1/adk/*`. Enquanto o AS não conhece o scope novo, a
 * CLI aceita o token que vier — o que ela nunca faz é inventar um audience.
 */

import { platform } from 'node:os';
import {
  beginLogin,
  claimsDoToken,
  ClientRegistrationError,
  exchangeCode,
  orgsDoToken,
  revokeToken,
  type LoginSession,
} from '../auth.js';
import { clearCredentials, loadCredentials, saveCredentials } from '../credentials.js';
import { executar } from '../exec.js';
import { accessToken } from '../hub.js';
import { authUrl, hubUrl, type Ctx } from '../ctx.js';

export async function comandoLogin(ctx: Ctx, opcoes: { org?: string } = {}): Promise<number> {
  const base = hubUrl(ctx);
  // Origem das rotas `/api/oauth/*`, em outro host que o Hub (ver `authUrl`).
  // A credencial continua indexada pelo HUB: é a ele que ela dá acesso.
  const as = authUrl(ctx);

  const sessao = await iniciarSessao(ctx, as, opcoes.org);
  if (!sessao) return 1;
  ctx.out('Abra este endereço no navegador para autorizar o ADK:');
  ctx.out('');
  ctx.out(`  ${sessao.authorizeUrl}`);
  ctx.out('');
  ctx.out(`Aguardando o retorno em http://127.0.0.1:${sessao.port}/callback ...`);
  await abrirNavegador(ctx, sessao.authorizeUrl);

  try {
    const code = await sessao.waitForCallback();
    const token = await exchangeCode({
      hubUrl: as,
      clientId: sessao.clientId,
      code,
      codeVerifier: sessao.codeVerifier,
      redirectUri: sessao.redirectUri,
    });
    const claims = claimsDoToken(token.access_token);
    await saveCredentials(
      { hubUrl: base, configDir: ctx.env.ADK_CONFIG_DIR },
      {
        client_id: sessao.clientId,
        redirect_uri: sessao.redirectUri,
        refresh_token: token.refresh_token ?? '',
        access_token: token.access_token,
        expires_at: Date.now() + (token.expires_in ?? 900) * 1000,
        user: claims.email ?? claims.sub ?? 'desconhecido',
      },
    );
    ctx.out(
      `Login concluído como ${claims.email ?? claims.sub ?? 'usuário'} (scope: ${token.scope ?? claims.scope ?? '—'}).`,
    );
    return 0;
  } catch (e) {
    ctx.err(`Login não concluído: ${(e as Error).message}`);
    return 1;
  } finally {
    await sessao.close();
  }
}

/**
 * Abre a sessão de login (listener + DCR). 404 no registro significa que o
 * host não serve o servidor de login.
 */
async function iniciarSessao(
  ctx: Ctx,
  as: string,
  org: string | undefined,
): Promise<LoginSession | null> {
  try {
    return await beginLogin({ hubUrl: as, org });
  } catch (e) {
    if (!(e instanceof ClientRegistrationError) || e.status !== 404) throw e;
    const exemplo =
      'https://app-staging.simplafy.com.br/hub (staging) ou https://app.simplafy.com.br/hub (produção)';
    const acao = ctx.env.ADK_AUTH_URL?.trim()
      ? `Confira ADK_AUTH_URL (hoje ${as}); o esperado é a base do servidor de autorização do Hub, ex.: ${exemplo}.`
      : `Defina ADK_AUTH_URL com a base do servidor de autorização do Hub, ex.: ${exemplo}.`;
    ctx.err(`O servidor de login não está em ${as} (404 em /api/oauth/register). ${acao}`);
    return null;
  }
}

function dicaAdkToken(ctx: Ctx): string {
  return ctx.env.ADK_TOKEN?.trim()
    ? ' Remova ADK_TOKEN do ambiente: ele tem prioridade sobre o login e continuaria valendo.'
    : '';
}

export async function comandoWhoami(ctx: Ctx): Promise<number> {
  const base = hubUrl(ctx);
  const token = await accessToken(ctx);
  if (!token) {
    ctx.err('Sem credencial para este Hub: rode `adk login` ou defina ADK_TOKEN.');
    return 1;
  }
  // API key (`sk_…`) não é JWT: mostrar o prefixo é tudo o que se pode dizer
  // dela sem perguntar ao Hub — e o segredo nunca aparece inteiro na tela.
  if (!token.includes('.')) {
    ctx.out(`Hub:     ${base}`);
    ctx.out(`Chave:   ${token.slice(0, 8)}…`);
    return 0;
  }
  const claims = claimsDoToken(token);
  const creds = await loadCredentials({ hubUrl: base, configDir: ctx.env.ADK_CONFIG_DIR });
  ctx.out(`Hub:     ${base}`);
  ctx.out(`Usuário: ${claims.email ?? creds?.user ?? claims.sub ?? '—'}`);
  ctx.out(`Audience: ${claims.aud ?? '—'} · scope: ${claims.scope ?? '—'}`);
  // O Hub só admite `aud` igual à string "adk" nas rotas `/api/v1/adk/*`
  // (array ou outro valor é recusado), mas aceita token SEM `aud` (JWT de
  // sessão do Hub). `whoami` lê as claims sem chamar o Hub, então sem este
  // aviso um token recusado parece válido e só falha no `plan`/`deploy`.
  if (Object.keys(claims).length === 0) {
    ctx.err(
      'Atenção: não consegui ler este token. Rode `adk login` de novo para entrar outra vez.' +
        dicaAdkToken(ctx),
    );
  } else {
    const aud: unknown = claims.aud;
    if (aud !== undefined && aud !== 'adk') {
      const atual = Array.isArray(aud) ? aud.join(', ') : String(aud);
      ctx.err(
        `Atenção: este token foi emitido para "${atual}", e não para o ADK. O Hub vai recusar esse token no \`adk plan\` e no \`adk deploy\`. Rode \`adk login\` de novo para entrar com um token do ADK.` +
          dicaAdkToken(ctx),
      );
    }
  }
  return 0;
}

export async function comandoOrgs(ctx: Ctx): Promise<number> {
  const token = await accessToken(ctx);
  if (!token) {
    ctx.err('Sem credencial para este Hub: rode `adk login` ou defina ADK_TOKEN.');
    return 1;
  }
  const orgs = orgsDoToken(claimsDoToken(token));
  if (orgs.length === 0) {
    ctx.out('O token não declara organizações. Use --org com o id da organização.');
    return 0;
  }
  for (const o of orgs) ctx.out(`  ${o.orgId}  ${o.role}`);
  return 0;
}

export async function comandoLogout(ctx: Ctx): Promise<number> {
  const base = hubUrl(ctx);
  const loc = { hubUrl: base, configDir: ctx.env.ADK_CONFIG_DIR };
  const creds = await loadCredentials(loc);
  if (!creds) {
    ctx.out('Nada para desconectar neste Hub.');
    return 0;
  }
  // Revoga ANTES de apagar: apagar só o arquivo deixaria um refresh token vivo
  // por 30 dias do lado do servidor.
  // Revoga no AS, não no Hub — o token foi emitido lá.
  await revokeToken({
    hubUrl: authUrl(ctx),
    clientId: creds.client_id,
    token: creds.refresh_token,
  });
  await clearCredentials(loc);
  ctx.out(`Desconectado de ${base}.`);
  return 0;
}

async function abrirNavegador(ctx: Ctx, url: string): Promise<void> {
  const comando = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
  // Falha é normal em servidor sem sessão gráfica — a URL já foi impressa.
  await executar(ctx, comando, [url], { timeoutMs: 5_000 }).catch(() => undefined);
}

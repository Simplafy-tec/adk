/**
 * `adk login` — authorization_code + PKCE S256 contra o AS OAuth do Hub.
 *
 * Três decisões de segurança que não são negociáveis:
 *   - o listener do callback sobe em **127.0.0.1** e em porta EFÊMERA. Em
 *     `0.0.0.0` qualquer um na mesma rede receberia o código de autorização;
 *   - o `state` é conferido antes de qualquer outra coisa: request com state
 *     errado é recusado e derruba a tentativa (não é ruído, é alguém tentando
 *     injetar um código);
 *   - o listener é ONE-SHOT: atende uma requisição e para de escutar.
 *
 * O client é registrado por DCR (RFC 7591) uma vez por máquina+Hub, sem
 * segredo (`token_endpoint_auth_method: none`) — CLI pública não tem onde
 * guardar segredo de cliente.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const SCOPE_ADK = 'adk';

export interface LoginSession {
  /** Endereço do listener — sempre 127.0.0.1. */
  address: string;
  port: number;
  authorizeUrl: string;
  state: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  /** Resolve com o `code` do callback; rejeita em state inválido ou erro do AS. */
  waitForCallback(): Promise<string>;
  close(): Promise<void>;
}

/** Verifier no alfabeto do RFC 7636 (43 chars a partir de 32 bytes). */
export function gerarCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export function deriveS256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export interface BeginLoginOptions {
  hubUrl: string;
  clientName?: string;
  /**
   * Pede o consentimento só desta organização (`org=<id>` no `/authorize`,
   * lido pela tela de consentimento do AS). Ausente, pede todas as elegíveis.
   */
  org?: string;
}

/**
 * Traduz o código cru do protocolo para o que a pessoa precisa fazer
 * (issue#2775).
 *
 * A CLI pede sempre `scope=adk`; se a resposta é `invalid_scope`, a causa
 * praticamente certa é a permissão não ter sido concedida na tela de
 * autorização. Repassar `invalid_scope` obrigava quem nunca ouviu falar de
 * scope a adivinhar — e isso é o PRIMEIRO contato de um dev externo com a
 * plataforma, no passo 2 do ciclo da ADR-121 §10.
 */
export function explicarErroDeAutorizacao(erro: string): string {
  if (erro === 'invalid_scope') {
    return (
      'O Hub recusou o login: invalid_scope — a permissão ADK não foi concedida na tela de ' +
      'autorização. Rode `adk login` de novo e deixe "Conceder permissão de ADK" ligado; sem ' +
      'ela não existe credencial de ADK.'
    );
  }
  if (erro === 'access_denied') {
    return 'O Hub recusou o login: a autorização foi negada na tela de consentimento.';
  }
  return `O Hub recusou o login: ${erro}`;
}

export async function beginLogin(options: BeginLoginOptions): Promise<LoginSession> {
  const hubUrl = options.hubUrl.replace(/\/+$/, '');
  const state = randomBytes(16).toString('base64url');
  const codeVerifier = gerarCodeVerifier();

  let resolver: (code: string) => void = () => {};
  let rejeitar: (erro: Error) => void = () => {};
  const callback = new Promise<string>((res, rej) => {
    resolver = res;
    rejeitar = rej;
  });
  // O callback pode falhar ANTES de alguém dar await (é o caso do request com
  // state errado). Sem este catch, a rejeição vira unhandled rejection e
  // derruba o processo por um erro que já está tratado.
  callback.catch(() => {});

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1`);
    if (url.pathname !== '/callback') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Rota desconhecida.');
      return;
    }
    // One-shot: uma requisição no /callback encerra a escuta, com ou sem êxito.
    server.close();
    const recebido = url.searchParams.get('state');
    if (recebido !== state) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('state inválido — o login foi cancelado.');
      rejeitar(new Error('state inválido no callback do login — tentativa descartada.'));
      return;
    }
    const erro = url.searchParams.get('error');
    if (erro) {
      const explicado = explicarErroDeAutorizacao(erro);
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Login recusado: ${erro}`);
      rejeitar(new Error(explicado));
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Callback sem code.');
      rejeitar(new Error('Callback do login veio sem code.'));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><body><p>Login concluído. Pode fechar esta aba.</p></body></html>');
    resolver(code);
  });

  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const { port, address } = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  let clientId: string;
  try {
    clientId = await registrarCliente(hubUrl, redirectUri, options.clientName);
  } catch (e) {
    server.close();
    throw e;
  }

  const authorize = new URL(`${hubUrl}/api/oauth/authorize`);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('scope', SCOPE_ADK);
  if (options.org) {
    // Consent de UMA org (`adk login --org`): quem não quer dar ao token
    // acesso a todas as suas organizações escolhe aqui.
    authorize.searchParams.set('org', options.org);
  } else {
    // Consent de TODAS as orgs elegíveis: a CLI aplica configuração em
    // qualquer organização em que o usuário seja ADMIN, e escolher uma aqui
    // exigiria refazer o login a cada cliente novo.
    authorize.searchParams.set('org_scope', 'all');
  }
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('code_challenge', deriveS256Challenge(codeVerifier));
  authorize.searchParams.set('code_challenge_method', 'S256');

  return {
    address,
    port,
    authorizeUrl: authorize.toString(),
    state,
    clientId,
    redirectUri,
    codeVerifier,
    waitForCallback: () => callback,
    close: () =>
      new Promise<void>((res) => {
        server.close(() => res());
        // `close` num servidor já fechado chama o callback com erro; resolver
        // aqui torna o encerramento idempotente para quem chama duas vezes.
        if (!server.listening) res();
      }),
  };
}

/**
 * O AS recusou o DCR. Carrega o status para o comando distinguir "não há AS
 * neste host" (404) de uma recusa de verdade do AS.
 */
export class ClientRegistrationError extends Error {
  constructor(readonly status: number) {
    super(`O Hub recusou o registro do cliente (${status}).`);
    this.name = 'ClientRegistrationError';
  }
}

/** DCR (RFC 7591) — um client público por máquina+Hub. */
async function registrarCliente(
  hubUrl: string,
  redirectUri: string,
  clientName = 'Simplafy ADK CLI',
): Promise<string> {
  const r = await fetch(`${hubUrl}/api/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE_ADK,
    }),
  });
  const corpo = (await r.json().catch(() => null)) as { client_id?: string } | null;
  if (!r.ok || !corpo?.client_id) {
    throw new ClientRegistrationError(r.status);
  }
  return corpo.client_id;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

async function pedirToken(hubUrl: string, corpo: URLSearchParams): Promise<TokenResponse> {
  const r = await fetch(`${hubUrl.replace(/\/+$/, '')}/api/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: corpo.toString(),
  });
  const texto = await r.text();
  let json: TokenResponse | { error?: string };
  try {
    json = JSON.parse(texto) as TokenResponse;
  } catch {
    throw new Error(`O Hub respondeu ${r.status} com corpo não-JSON no /token.`);
  }
  if (!r.ok || !('access_token' in json)) {
    const erro = (json as { error?: string }).error ?? r.status;
    throw new Error(`Troca de token recusada pelo Hub: ${erro}`);
  }
  return json as TokenResponse;
}

export function exchangeCode(input: {
  hubUrl: string;
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  return pedirToken(
    input.hubUrl,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
      client_id: input.clientId,
    }),
  );
}

export function refreshTokens(input: {
  hubUrl: string;
  clientId: string;
  refreshToken: string;
}): Promise<TokenResponse> {
  return pedirToken(
    input.hubUrl,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: input.clientId,
    }),
  );
}

export async function revokeToken(input: {
  hubUrl: string;
  clientId: string;
  token: string;
}): Promise<void> {
  await fetch(`${input.hubUrl.replace(/\/+$/, '')}/api/oauth/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: input.token, client_id: input.clientId }).toString(),
  }).catch(() => undefined);
}

/** Claims que a CLI lê do access token para `whoami`/`orgs` — sem verificar assinatura. */
export interface AccessClaims {
  sub?: string;
  email?: string;
  aud?: string;
  scope?: string;
  org?: string;
  role?: string;
  orgs?: OrgDoToken[];
  exp?: number;
}

/** Uma organização que o token alcança. `name` só vem se o AS o incluir. */
export interface OrgDoToken {
  orgId: string;
  role: string;
  name?: string;
}

/** As orgs do token: a claim `orgs`, ou a org única (`org`/`role`) dos tokens antigos. */
export function orgsDoToken(claims: AccessClaims): OrgDoToken[] {
  if (claims.orgs) return claims.orgs;
  return claims.org ? [{ orgId: claims.org, role: claims.role ?? '—' }] : [];
}

/**
 * Lê o payload do JWT SEM validar assinatura — de propósito: quem valida é o
 * Hub. Aqui só se mostra ao usuário o que ele já tem em mãos; tratar isto como
 * autorização seria confiar num token que o próprio cliente escreveu.
 */
export function claimsDoToken(token: string): AccessClaims {
  const parte = token.split('.')[1];
  if (!parte) return {};
  try {
    return JSON.parse(Buffer.from(parte, 'base64url').toString('utf8')) as AccessClaims;
  } catch {
    return {};
  }
}

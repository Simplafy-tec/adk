/**
 * Cliente do Docker Registry v2 para o `adk publish`: token pelo Hub e push.
 *
 * Protocolo de token (distribution/distribution): `GET /v2/` responde 401 com
 * `WWW-Authenticate: Bearer realm=…,service=…`; o token sai do realm, pedido
 * com o bearer do ADK; o push vai pela HTTP API com o token do REGISTRY. A
 * credencial do ADK só viaja até o realm, e o realm só é aceito na MESMA origem
 * do Hub configurado — um registry que anunciasse outro realm receberia, de
 * graça, o token do autor.
 */

import { type DocumentoManifesto, type Descritor, type LayoutOci } from './oci-layout.js';

export class PublicacaoError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'PublicacaoError';
  }
}

/** Renova antes do fim: um token que expira no meio do push vira 401 no blob do meio. */
const MARGEM_TOKEN_MS = 30_000;
const TTL_PADRAO_S = 60;

const MEDIA_INDICES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);

interface Desafio {
  esquema: string;
  parametros: Record<string, string>;
}

function lerDesafio(cabecalho: string | null): Desafio | null {
  if (!cabecalho) return null;
  const espaco = cabecalho.indexOf(' ');
  const esquema = (espaco === -1 ? cabecalho : cabecalho.slice(0, espaco)).trim().toLowerCase();
  const parametros: Record<string, string> = {};
  for (const m of cabecalho.slice(espaco + 1).matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) {
    parametros[m[1].toLowerCase()] = m[2];
  }
  return { esquema, parametros };
}

interface AccessItem {
  type?: string;
  name?: string;
  actions?: string[];
}

/** `access` do payload do JWT — o CLI não confere a assinatura; quem confere é o registry. */
function accessDoJwt(token: string): AccessItem[] {
  const payload = token.split('.')[1];
  if (!payload) throw new PublicacaoError('O Hub devolveu um token de registry ilegível.');
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      access?: unknown;
    };
    return Array.isArray(claims.access) ? (claims.access as AccessItem[]) : [];
  } catch {
    throw new PublicacaoError('O Hub devolveu um token de registry ilegível.');
  }
}

export interface DestinoRegistry {
  /** Base do registry, sem barra final (`https://registry.simplafy.com.br`). */
  base: string;
  /** `simplafy-tec/<slug>`. */
  repositorio: string;
  hubUrl: string;
  /** Lido só quando o registry exige token — `null` vira o erro padrão de credencial. */
  credencialAdk: () => Promise<string | null>;
}

interface TokenRegistry {
  valor: string;
  expiraEm: number;
}

export class ClienteRegistry {
  private token: TokenRegistry | null = null;
  private realm: URL | null = null;
  private service: string | undefined;

  constructor(private readonly destino: DestinoRegistry) {}

  /**
   * Descobre como o registry autentica e já obtém o token do push — é aqui que
   * o autor sem papel na org é recusado, antes de qualquer build.
   */
  async autorizar(): Promise<void> {
    let resposta: Response;
    try {
      resposta = await fetch(`${this.destino.base}/v2/`);
    } catch (e) {
      throw new PublicacaoError(
        `Não consegui falar com o registry ${this.destino.base}: ${(e as Error).message}`,
      );
    }
    if (resposta.ok) return; // registry sem autenticação: o push vai sem token
    if (resposta.status !== 401) {
      throw new PublicacaoError(
        `O registry ${this.destino.base} respondeu ${resposta.status} em /v2/ — não parece um Docker Registry v2.`,
      );
    }

    const desafio = lerDesafio(resposta.headers.get('www-authenticate'));
    if (!desafio || desafio.esquema !== 'bearer' || !desafio.parametros.realm) {
      throw new PublicacaoError(
        `O registry ${this.destino.base} ainda não aceita o token do Hub: ele pede ` +
          `${desafio?.esquema === 'basic' ? 'usuário e senha' : 'outro tipo de autenticação'}, ` +
          'e o adk publish só publica com a credencial do Hub. Fale com o seu contato na ' +
          'Simplafy para ligar a autenticação por token neste registry.',
      );
    }

    let realm: URL;
    try {
      realm = new URL(desafio.parametros.realm);
    } catch {
      throw new PublicacaoError(
        `O registry anunciou um realm que não é URL: ${desafio.parametros.realm}`,
      );
    }
    const origemHub = new URL(this.destino.hubUrl).origin;
    if (realm.origin !== origemHub) {
      throw new PublicacaoError(
        `O registry ${this.destino.base} manda pedir o token em ${realm.origin}, que não é o Hub ` +
          `configurado (${origemHub}). O adk publish só entrega a credencial do ADK ao próprio Hub — ` +
          'confira ADK_HUB_URL/--profile e o registry de destino.',
      );
    }
    this.realm = realm;
    this.service = desafio.parametros.service;
    await this.renovarToken();
  }

  private async renovarToken(): Promise<void> {
    if (!this.realm) return;
    const credencial = await this.destino.credencialAdk();
    if (!credencial)
      throw new PublicacaoError('Sem credencial: rode `adk login` ou defina ADK_TOKEN.');

    const url = new URL(this.realm);
    if (this.service) url.searchParams.set('service', this.service);
    url.searchParams.append('scope', `repository:${this.destino.repositorio}:push,pull`);

    // Sem seguir redirect: um 302 do realm levaria o bearer do ADK a outra origem.
    let resposta: Response;
    try {
      resposta = await fetch(url, {
        headers: { authorization: `Bearer ${credencial}` },
        redirect: 'error',
      });
    } catch {
      throw new PublicacaoError(
        `O pedido de token ao Hub (${url.origin}) falhou ou foi redirecionado — o adk publish não segue redirect com a credencial do ADK.`,
      );
    }
    if (resposta.status === 401) {
      throw new PublicacaoError(
        'O Hub recusou a credencial do ADK (401): rode `adk login` de novo.',
      );
    }
    if (!resposta.ok) {
      throw new PublicacaoError(`O Hub não emitiu o token do registry (${resposta.status}).`);
    }
    const corpo = (await resposta.json().catch(() => ({}))) as {
      token?: string;
      access_token?: string;
      expires_in?: number;
    };
    const valor = corpo.token ?? corpo.access_token;
    if (!valor) throw new PublicacaoError('O Hub respondeu sem token de registry.');

    const liberado = accessDoJwt(valor).some(
      (item) =>
        item.type === 'repository' &&
        item.name === this.destino.repositorio &&
        (item.actions ?? []).includes('push'),
    );
    if (!liberado) {
      throw new PublicacaoError(
        `O Hub não liberou o push em ${this.destino.repositorio}: publicar exige papel ADMIN (ou ` +
          'OWNER) na organização dona do componente — confira com `adk orgs`. Se o slug já ' +
          'pertence a outra organização, escolha outro.',
      );
    }
    this.token = { valor, expiraEm: Date.now() + (corpo.expires_in ?? TTL_PADRAO_S) * 1000 };
  }

  private async cabecalhos(extras: Record<string, string> = {}): Promise<Record<string, string>> {
    if (this.token && Date.now() > this.token.expiraEm - MARGEM_TOKEN_MS) await this.renovarToken();
    return this.token ? { ...extras, authorization: `Bearer ${this.token.valor}` } : extras;
  }

  /** O bearer do registry só segue para a origem do próprio registry. */
  private urlDoRegistry(caminhoOuUrl: string): URL {
    const url = new URL(caminhoOuUrl, `${this.destino.base}/`);
    if (url.origin !== new URL(this.destino.base).origin) {
      throw new PublicacaoError(
        `O registry mandou continuar o upload em outra origem (${url.origin}) — recusado.`,
      );
    }
    return url;
  }

  private async enviarBlob(layout: LayoutOci, descritor: Descritor): Promise<void> {
    const repo = this.destino.repositorio;
    const existe = await fetch(this.urlDoRegistry(`/v2/${repo}/blobs/${descritor.digest}`), {
      method: 'HEAD',
      headers: await this.cabecalhos(),
    });
    if (existe.ok) return;

    const bytes = layout.blob(descritor.digest);
    const inicio = await fetch(this.urlDoRegistry(`/v2/${repo}/blobs/uploads/`), {
      method: 'POST',
      headers: await this.cabecalhos(),
    });
    const local = inicio.headers.get('location');
    if (inicio.status !== 202 || !local) {
      throw new PublicacaoError(
        `O registry recusou o início do upload de ${descritor.digest} (${inicio.status}).`,
      );
    }
    const destino = this.urlDoRegistry(local);
    destino.searchParams.set('digest', descritor.digest);
    const fim = await fetch(destino, {
      method: 'PUT',
      headers: await this.cabecalhos({ 'content-type': 'application/octet-stream' }),
      body: bytes,
    });
    if (fim.status !== 201) {
      throw new PublicacaoError(`O registry recusou o blob ${descritor.digest} (${fim.status}).`);
    }
  }

  /**
   * Sobe o manifesto e tudo o que ele referencia, filhos antes: o registry
   * recusa manifesto que aponta para o que ainda não existe nele.
   */
  async enviarManifesto(
    layout: LayoutOci,
    descritor: Descritor,
    enviados = new Set<string>(),
  ): Promise<void> {
    if (enviados.has(descritor.digest)) return;
    const bytes = layout.blob(descritor.digest);
    const documento = JSON.parse(bytes.toString('utf8')) as DocumentoManifesto;
    const mediaType = descritor.mediaType ?? documento.mediaType;
    if (!mediaType)
      throw new PublicacaoError(`O manifesto ${descritor.digest} não declara media type.`);

    if (MEDIA_INDICES.has(mediaType)) {
      for (const filho of documento.manifests ?? [])
        await this.enviarManifesto(layout, filho, enviados);
    } else {
      const blobs = [documento.config, ...(documento.layers ?? [])].filter(
        (d): d is Descritor => d !== undefined,
      );
      for (const blob of blobs) await this.enviarBlob(layout, blob);
    }

    await this.gravarManifesto(descritor.digest, bytes, mediaType, descritor.digest);
    enviados.add(descritor.digest);
  }

  /** Aponta `tag` para o manifesto de topo já enviado (mesmos bytes, mesmo digest). */
  async etiquetar(layout: LayoutOci, topo: Descritor, tag: string): Promise<void> {
    const bytes = layout.blob(topo.digest);
    const mediaType =
      topo.mediaType ?? (JSON.parse(bytes.toString('utf8')) as DocumentoManifesto).mediaType;
    if (!mediaType) throw new PublicacaoError(`O manifesto ${topo.digest} não declara media type.`);
    await this.gravarManifesto(tag, bytes, mediaType, topo.digest);
  }

  private async gravarManifesto(
    referencia: string,
    bytes: Buffer,
    mediaType: string,
    digest: string,
  ): Promise<void> {
    const resposta = await fetch(
      this.urlDoRegistry(`/v2/${this.destino.repositorio}/manifests/${referencia}`),
      { method: 'PUT', headers: await this.cabecalhos({ 'content-type': mediaType }), body: bytes },
    );
    if (resposta.status !== 201) {
      throw new PublicacaoError(
        `O registry recusou o manifesto ${referencia} (${resposta.status}).`,
      );
    }
    const confirmado = resposta.headers.get('docker-content-digest');
    if (confirmado && confirmado !== digest) {
      throw new PublicacaoError(
        `O registry gravou o manifesto com outro digest (${confirmado}, esperado ${digest}).`,
      );
    }
  }
}

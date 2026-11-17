import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { parse } from 'yaml';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';

// `adk publish` — constrói a imagem do satélite (`kind: mcp`), empurra pela
// HTTP API do registry com o token que o Hub emite (protocolo de token do
// Docker Registry v2) e grava o digest no `image:` do manifest.yaml.
//
// Aqui o registry e o Hub são falsos (msw) e o `docker` é um script no PATH
// que devolve um layout OCI montado pelo teste: o que se prova é o protocolo e
// o efeito do outro lado (o que o registry recebeu e o que ficou no arquivo).
// A prova contra um `registry:3` de verdade está em `adk-publish-e2e.test.ts`.

const HUB = 'http://hub-mock.test';
// O único registry remoto da allowlist do publish (o resto é loopback).
const REGISTRY = 'https://registry.simplafy.com.br';
const REGISTRY_HOST = 'registry.simplafy.com.br';
const REALM = `${HUB}/api/v1/adk/registry/token`;
const SERVICE = 'registry.simplafy.test';
const ADK_TOKEN = 'adk-token-do-usuario';
const SLUG = 'demo-satelite';
const REPO = `simplafy-tec/${SLUG}`;

// --- JWT do registry (o CLI só lê o payload; quem confere a assinatura é o registry) ---

interface AccessItem {
  type: string;
  name: string;
  actions: string[];
}

function registryJwt(access: AccessItem[]): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  return [
    b64({ alg: 'RS256', typ: 'JWT', x5c: ['MIIBfake'] }),
    b64({
      iss: 'hub-test',
      sub: 'user-1',
      aud: SERVICE,
      iat,
      nbf: iat,
      exp: iat + 300,
      jti: randomUUID(),
      access,
    }),
    'assinatura-falsa',
  ].join('.');
}

// --- Estado do Hub falso ---------------------------------------------------

interface PedidoDeToken {
  authorization: string | null;
  service: string | null;
  scopes: string[];
}

let pedidosDeToken: PedidoDeToken[] = [];
/** O que o Hub concede — padrão: push+pull no repositório do componente. */
let accessConcedido: AccessItem[] = [];
let registryToken = '';

// --- Estado do registry falso ----------------------------------------------

interface PedidoAoRegistry {
  method: string;
  path: string;
  authorization: string | null;
}

let challenge: 'bearer' | 'basic' = 'bearer';
/** Realm anunciado no challenge — por padrão, o do Hub do teste (mesma origem). */
let realmDoChallenge = REALM;
/** O registry real só aceita o repositório que o JWT concede; aqui, o do componente. */
let repoAceito = REPO;
let pedidosAoRegistry: PedidoAoRegistry[] = [];
let blobsNoRegistry = new Map<string, Buffer>();
let manifestsNoRegistry = new Map<string, { body: Buffer; contentType: string | null }>();
/** Ordem de chegada dos PUT de manifest por digest. */
let ordemDosManifests: string[] = [];
/** PUT de manifest por TAG: tag → digest do corpo. */
let tagsNoRegistry = new Map<string, string>();
/** `Docker-Content-Digest` mentiroso na resposta do PUT de manifest. */
let digestDivergente = false;
/** `Location` do início de upload apontando para outra origem. */
let localDeUploadEstrangeiro: string | null = null;
const uploads = new Map<string, Buffer[]>();

function sha256(buf: Buffer): string {
  return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
}

function respostaDeChallenge(): Response {
  const cabecalho =
    challenge === 'basic'
      ? 'Basic realm="Registry Realm"'
      : `Bearer realm="${realmDoChallenge}",service="${SERVICE}"`;
  return HttpResponse.json(
    { errors: [{ code: 'UNAUTHORIZED', message: 'authentication required' }] },
    { status: 401, headers: { 'www-authenticate': cabecalho } },
  );
}

/** Espelha o registry real: só o JWT emitido pelo Hub, e só no repositório do componente. */
function autorizado(authorization: string | null, repo: string | null): boolean {
  if (challenge === 'basic') return false;
  if (!registryToken || authorization !== `Bearer ${registryToken}`) return false;
  return repo === null || repo === repoAceito;
}

async function registryFalso({ request }: { request: Request }): Promise<Response> {
  const url = new URL(request.url);
  const authorization = request.headers.get('authorization');
  pedidosAoRegistry.push({ method: request.method, path: url.pathname, authorization });

  if (url.pathname === '/v2/' || url.pathname === '/v2') {
    return autorizado(authorization, null) ? HttpResponse.json({}) : respostaDeChallenge();
  }

  const m = url.pathname.match(/^\/v2\/(.+)\/(blobs|manifests)\/(.*)$/);
  if (!m) return HttpResponse.json({ errors: [{ code: 'NAME_UNKNOWN' }] }, { status: 404 });
  const [, repo, tipo, resto] = m;
  if (!autorizado(authorization, repo)) return respostaDeChallenge();

  const corpo = Buffer.from(await request.arrayBuffer());

  if (tipo === 'blobs' && resto.startsWith('uploads')) {
    const id = resto.replace(/^uploads\/?/, '');
    const digest = url.searchParams.get('digest');
    if (request.method === 'POST') {
      if (digest && corpo.length > 0) {
        if (sha256(corpo) !== digest) return HttpResponse.json({}, { status: 400 });
        blobsNoRegistry.set(digest, corpo);
        return new HttpResponse(null, {
          status: 201,
          headers: { location: `${REGISTRY}/v2/${repo}/blobs/${digest}`, 'docker-content-digest': digest },
        });
      }
      const novo = randomUUID();
      uploads.set(novo, []);
      return new HttpResponse(null, {
        status: 202,
        headers: {
          location: localDeUploadEstrangeiro ?? `${REGISTRY}/v2/${repo}/blobs/uploads/${novo}`,
          'docker-upload-uuid': novo,
          range: '0-0',
        },
      });
    }
    const partes = uploads.get(id);
    if (!partes) return HttpResponse.json({ errors: [{ code: 'BLOB_UPLOAD_UNKNOWN' }] }, { status: 404 });
    if (corpo.length > 0) partes.push(corpo);
    if (request.method === 'PATCH') {
      const total = partes.reduce((n, p) => n + p.length, 0);
      return new HttpResponse(null, {
        status: 202,
        headers: {
          location: `${REGISTRY}/v2/${repo}/blobs/uploads/${id}`,
          range: `0-${Math.max(total - 1, 0)}`,
        },
      });
    }
    if (request.method === 'PUT' && digest) {
      const blob = Buffer.concat(partes);
      if (sha256(blob) !== digest) {
        return HttpResponse.json({ errors: [{ code: 'DIGEST_INVALID' }] }, { status: 400 });
      }
      blobsNoRegistry.set(digest, blob);
      uploads.delete(id);
      return new HttpResponse(null, {
        status: 201,
        headers: { location: `${REGISTRY}/v2/${repo}/blobs/${digest}`, 'docker-content-digest': digest },
      });
    }
    return HttpResponse.json({}, { status: 405 });
  }

  if (tipo === 'blobs') {
    const blob = blobsNoRegistry.get(resto);
    if (!blob) return new HttpResponse(null, { status: 404 });
    if (request.method === 'HEAD') {
      return new HttpResponse(null, {
        status: 200,
        headers: { 'content-length': String(blob.length), 'docker-content-digest': resto },
      });
    }
    return new HttpResponse(blob, { status: 200 });
  }

  // manifests
  if (request.method === 'PUT') {
    const digest = sha256(corpo);
    const doc = JSON.parse(corpo.toString('utf8')) as {
      manifests?: { digest: string }[];
      config?: { digest: string };
      layers?: { digest: string }[];
    };
    // Como o Distribution: manifesto que referencia o que ainda não subiu é recusado.
    const filhos = doc.manifests?.map((f) => f.digest) ?? [];
    const blobs = [doc.config?.digest, ...(doc.layers ?? []).map((l) => l.digest)].filter(
      (d): d is string => typeof d === 'string',
    );
    if (filhos.some((d) => !manifestsNoRegistry.has(d)) || blobs.some((d) => !blobsNoRegistry.has(d))) {
      return HttpResponse.json({ errors: [{ code: 'MANIFEST_BLOB_UNKNOWN' }] }, { status: 400 });
    }
    // Como o Distribution: referência por digest tem que bater com o corpo.
    if (resto.startsWith('sha256:') && resto !== digest) {
      return HttpResponse.json({ errors: [{ code: 'DIGEST_INVALID' }] }, { status: 400 });
    }
    manifestsNoRegistry.set(digest, { body: corpo, contentType: request.headers.get('content-type') });
    if (resto.startsWith('sha256:')) ordemDosManifests.push(digest);
    else tagsNoRegistry.set(resto, digest);
    const anunciado = digestDivergente ? sha256(Buffer.from(`outro-${digest}`)) : digest;
    return new HttpResponse(null, {
      status: 201,
      headers: { location: `${REGISTRY}/v2/${repo}/manifests/${digest}`, 'docker-content-digest': anunciado },
    });
  }
  const guardado = manifestsNoRegistry.get(tagsNoRegistry.get(resto) ?? resto);
  if (!guardado) return HttpResponse.json({ errors: [{ code: 'MANIFEST_UNKNOWN' }] }, { status: 404 });
  return new HttpResponse(request.method === 'HEAD' ? null : guardado.body, {
    status: 200,
    headers: { 'docker-content-digest': resto, 'content-type': guardado.contentType ?? '' },
  });
}

const server = setupServer(
  http.get(REALM, ({ request }) => {
    const url = new URL(request.url);
    pedidosDeToken.push({
      authorization: request.headers.get('authorization'),
      service: url.searchParams.get('service'),
      scopes: url.searchParams.getAll('scope'),
    });
    if (request.headers.get('authorization') !== `Bearer ${ADK_TOKEN}`) {
      return HttpResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }
    registryToken = registryJwt(accessConcedido);
    return HttpResponse.json({
      token: registryToken,
      access_token: registryToken,
      expires_in: 300,
      issued_at: new Date().toISOString(),
    });
  }),
  http.all(`${REGISTRY}/*`, registryFalso),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

// --- Layout OCI que o `docker save` (Docker >= 25) produz -------------------

interface ImagemOci {
  tar: string;
  /** Digest do manifesto que o `index.json` aponta — é o que o publish imprime. */
  digestTopo: string;
  manifests: Map<string, Buffer>;
  blobs: Map<string, Buffer>;
}

/**
 * Monta o tar de um `docker save`. `aninhado` reproduz o image store do
 * containerd (Docker 29 desta máquina, medido): `index.json` aponta para um
 * IMAGE INDEX, que lista o manifesto da plataforma e o de atestação.
 */
function montarImagemOci(
  dir: string,
  opcoes: { aninhado: boolean; adulterarCamada?: boolean },
): ImagemOci {
  const layout = join(dir, 'layout');
  const blobsDir = join(layout, 'blobs', 'sha256');
  mkdirSync(blobsDir, { recursive: true });
  const manifests = new Map<string, Buffer>();
  const blobs = new Map<string, Buffer>();
  const gravar = (buf: Buffer) => {
    const digest = sha256(buf);
    writeFileSync(join(blobsDir, digest.slice('sha256:'.length)), buf);
    return { digest, size: buf.length };
  };

  const config = Buffer.from(
    JSON.stringify({ architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: [] } }),
  );
  const camada = Buffer.from(`camada-${randomUUID()}`);
  const cfg = gravar(config);
  const cam = gravar(camada);
  if (opcoes.adulterarCamada) {
    // Conteúdo trocado depois do digest: o arquivo do blob não confere mais com o nome.
    writeFileSync(join(blobsDir, cam.digest.slice('sha256:'.length)), Buffer.from('adulterado'));
  }
  blobs.set(cfg.digest, config);
  blobs.set(cam.digest, camada);
  const manifesto = Buffer.from(
    JSON.stringify(
      {
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: { mediaType: 'application/vnd.oci.image.config.v1+json', ...cfg },
        layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', ...cam }],
      },
      null,
      2,
    ),
  );
  const man = gravar(manifesto);
  manifests.set(man.digest, manifesto);

  let topo = { ...man, mediaType: 'application/vnd.oci.image.manifest.v1+json' };
  if (opcoes.aninhado) {
    const indice = Buffer.from(
      JSON.stringify(
        {
          schemaVersion: 2,
          mediaType: 'application/vnd.oci.image.index.v1+json',
          manifests: [
            {
              mediaType: 'application/vnd.oci.image.manifest.v1+json',
              ...man,
              platform: { architecture: 'amd64', os: 'linux' },
            },
          ],
        },
        null,
        2,
      ),
    );
    const idx = gravar(indice);
    manifests.set(idx.digest, indice);
    topo = { ...idx, mediaType: 'application/vnd.oci.image.index.v1+json' };
  }

  writeFileSync(join(layout, 'oci-layout'), JSON.stringify({ imageLayoutVersion: '1.0.0' }));
  writeFileSync(
    join(layout, 'index.json'),
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [
        {
          ...topo,
          annotations: {
            'io.containerd.image.name': `docker.io/library/${SLUG}:adk`,
            'org.opencontainers.image.ref.name': 'adk',
          },
        },
      ],
    }),
  );
  const tar = join(dir, 'imagem.tar');
  execFileSync('tar', ['-cf', tar, '-C', layout, 'oci-layout', 'index.json', 'blobs']);
  return { tar, digestTopo: topo.digest, manifests, blobs };
}

/**
 * `docker` falso: registra a chamada e o ambiente que recebeu; `save` entrega
 * o tar do teste em `-o`/`--output` (ou na saída padrão). `build` falha quando
 * `falharBuild`.
 */
function instalarDockerFalso(
  dir: string,
  tar: string,
  opcoes: { falharBuild?: boolean; aoConstruir?: string } = {},
) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const chamadas = join(dir, 'docker-chamadas.log');
  const ambiente = join(dir, 'docker-env.log');
  writeFileSync(
    join(bin, 'docker'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${chamadas}'`,
      `env >> '${ambiente}'`,
      'case "$1" in',
      `  build) ${opcoes.aoConstruir ?? ':'}; ${opcoes.falharBuild ? "echo 'ERROR: failed to solve: dockerfile parse error' >&2; exit 1" : 'exit 0'} ;;`,
      '  save)',
      '    saida=""; anterior=""',
      '    for a in "$@"; do',
      '      if [ "$anterior" = "-o" ] || [ "$anterior" = "--output" ]; then saida="$a"; fi',
      '      case "$a" in --output=*) saida="${a#--output=}" ;; esac',
      '      anterior="$a"',
      '    done',
      `    if [ -n "$saida" ]; then cp '${tar}' "$saida"; else cat '${tar}'; fi`,
      '    exit 0 ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'docker'), 0o755);
  const ler = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  return {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    chamadas: () => ler(chamadas),
    ambiente: () => ler(ambiente),
  };
}

function manifestoMcp(opcoes: { slug?: string; kind?: string; image?: string } = {}): string {
  return [
    '# Satélite de pedidos — mantido pelo time de integrações.',
    'spec_version: v1',
    `kind: ${opcoes.kind ?? 'mcp'}`,
    `slug: ${opcoes.slug ?? SLUG}`,
    'name: Demo satélite',
    '# Imagem do satélite POR DIGEST — tag é mutável e o Hub não aceita.',
    `image: ${opcoes.image ?? `TROQUE — ghcr.io/simplafy-tec/${opcoes.slug ?? SLUG}@sha256:<64 hex>`}`,
    '# URL pública do satélite já em execução (host público, nunca interno).',
    'url: https://demo.example/mcp',
    'tools:',
    '  - buscar_pedido # a principal',
    '  - listar_pedidos',
    '',
  ].join('\n');
}

function linhaImage(texto: string): string {
  return texto.split('\n').find((l) => l.startsWith('image:')) ?? '';
}

const SEM_STACK = /^\s+at\s/m;

let raiz: string;
let componente: string;
let imagem: ImagemOci;
let docker: ReturnType<typeof instalarDockerFalso>;

beforeEach(() => {
  raiz = mkdtempSync(join(tmpdir(), 'adk-publish-'));
  componente = join(raiz, 'satelite');
  mkdirSync(componente, { recursive: true });
  writeFileSync(join(componente, 'Dockerfile'), 'FROM scratch\nCOPY server.py /server.py\n');
  writeFileSync(join(componente, 'server.py'), 'print("ok")\n');
  writeFileSync(join(componente, 'manifest.yaml'), manifestoMcp());
  imagem = montarImagemOci(join(raiz, 'oci'), { aninhado: false });
  docker = instalarDockerFalso(raiz, imagem.tar);

  challenge = 'bearer';
  realmDoChallenge = REALM;
  repoAceito = REPO;
  accessConcedido = [{ type: 'repository', name: REPO, actions: ['push', 'pull'] }];
  registryToken = '';
  pedidosDeToken = [];
  pedidosAoRegistry = [];
  blobsNoRegistry = new Map();
  manifestsNoRegistry = new Map();
  ordemDosManifests = [];
  tagsNoRegistry = new Map();
  digestDivergente = false;
  localDeUploadEstrangeiro = null;
  uploads.clear();
});

afterEach(() => {
  server.resetHandlers();
  rmSync(raiz, { recursive: true, force: true });
});

function publicar(
  argsExtras: string[] = [],
  env: Record<string, string | undefined> = {},
  opcoes: { stdin?: NodeJS.ReadableStream & { isTTY?: boolean }; cwd?: string } = {},
) {
  return runCli(['publish', '--dir', componente, '--registry', REGISTRY, ...argsExtras], {
    cwd: opcoes.cwd ?? raiz,
    env: { ADK_HUB_URL: HUB, ADK_TOKEN, PATH: docker.PATH, ...env },
    stdin: opcoes.stdin,
  });
}

/** Pedidos que de fato empurram algo (upload de blob ou PUT de manifest). */
function pushes(): PedidoAoRegistry[] {
  return pedidosAoRegistry.filter((p) => ['POST', 'PATCH', 'PUT'].includes(p.method));
}

describe('adk publish — caminho feliz', () => {
  it('imprime o digest sha256 do manifesto que o index.json do docker save aponta', async () => {
    const r = await publicar();
    expect({ exitCode: r.exitCode, digest: r.stdout.match(/sha256:[0-9a-f]{64}/)?.[0] }).toEqual({
      exitCode: 0,
      digest: imagem.digestTopo,
    });
  });

  it('o registry recebe o manifesto com os mesmos bytes do layout e todos os blobs que ele referencia', async () => {
    await publicar();
    expect({
      manifesto: manifestsNoRegistry.get(imagem.digestTopo)?.body.toString('utf8'),
      blobs: [...blobsNoRegistry.keys()].sort(),
    }).toEqual({
      manifesto: imagem.manifests.get(imagem.digestTopo)?.toString('utf8'),
      blobs: [...imagem.blobs.keys()].sort(),
    });
  });

  it('o manifesto sobe com o media type OCI declarado no layout', async () => {
    await publicar();
    expect(manifestsNoRegistry.get(imagem.digestTopo)?.contentType).toBe(
      'application/vnd.oci.image.manifest.v1+json',
    );
  });

  it('reescreve só a linha image: do manifest.yaml para <registry>/simplafy-tec/<slug>@<digest>, preservando comentários e o resto', async () => {
    const antes = readFileSync(join(componente, 'manifest.yaml'), 'utf8');
    await publicar();
    const esperado = antes.replace(
      linhaImage(antes),
      `image: ${REGISTRY_HOST}/${REPO}@${imagem.digestTopo}`,
    );
    expect(readFileSync(join(componente, 'manifest.yaml'), 'utf8')).toBe(esperado);
  });

  it('troca o digest de uma publicação anterior pelo novo', async () => {
    const antigo = `image: ${REGISTRY_HOST}/${REPO}@sha256:${'a'.repeat(64)}`;
    writeFileSync(
      join(componente, 'manifest.yaml'),
      manifestoMcp({ image: antigo.slice('image: '.length) }),
    );
    await publicar();
    expect(linhaImage(readFileSync(join(componente, 'manifest.yaml'), 'utf8'))).toBe(
      `image: ${REGISTRY_HOST}/${REPO}@${imagem.digestTopo}`,
    );
  });

  it('sem --dir, publica o componente do diretório corrente', async () => {
    const r = await runCli(['publish', '--registry', REGISTRY], {
      cwd: componente,
      env: { ADK_HUB_URL: HUB, ADK_TOKEN, PATH: docker.PATH },
    });
    expect({ exitCode: r.exitCode, linha: linhaImage(readFileSync(join(componente, 'manifest.yaml'), 'utf8')) }).toEqual({
      exitCode: 0,
      linha: `image: ${REGISTRY_HOST}/${REPO}@${imagem.digestTopo}`,
    });
  });

  it('constrói a imagem a partir do diretório do componente (docker build com o contexto do --dir)', async () => {
    await publicar();
    const build = docker
      .chamadas()
      .split('\n')
      .find((l) => l.startsWith('build'));
    expect(build).toContain(componente);
  });

  it('o docker build não recebe a credencial do Hub no ambiente', async () => {
    await publicar();
    const ambiente = docker.ambiente();
    expect({ executou: ambiente.includes('PATH='), vazou: ambiente.includes(ADK_TOKEN) }).toEqual({
      executou: true,
      vazou: false,
    });
  });

  it('slug que contém um prefixo reservado no MEIO (meu-hub-mcp) não é reservado e publica', async () => {
    writeFileSync(join(componente, 'manifest.yaml'), manifestoMcp({ slug: 'meu-hub-mcp' }));
    accessConcedido = [{ type: 'repository', name: 'simplafy-tec/meu-hub-mcp', actions: ['push', 'pull'] }];
    repoAceito = 'simplafy-tec/meu-hub-mcp';
    const r = await publicar();
    expect({ exitCode: r.exitCode, gravados: manifestsNoRegistry.has(imagem.digestTopo) }).toEqual({
      exitCode: 0,
      gravados: true,
    });
  });
});

describe('adk publish — layout aninhado do image store do containerd', () => {
  beforeEach(() => {
    imagem = montarImagemOci(join(raiz, 'oci-aninhado'), { aninhado: true });
    docker = instalarDockerFalso(raiz, imagem.tar);
  });

  it('imprime e grava o digest do IMAGE INDEX que o index.json aponta', async () => {
    const r = await publicar();
    expect({
      impresso: r.stdout.match(/sha256:[0-9a-f]{64}/)?.[0],
      gravado: linhaImage(readFileSync(join(componente, 'manifest.yaml'), 'utf8')),
    }).toEqual({
      impresso: imagem.digestTopo,
      gravado: `image: ${REGISTRY_HOST}/${REPO}@${imagem.digestTopo}`,
    });
  });

  it('empurra o manifesto da plataforma antes do índice que o referencia', async () => {
    await publicar();
    const filho = [...imagem.manifests.keys()].find((d) => d !== imagem.digestTopo);
    expect(ordemDosManifests).toEqual([filho, imagem.digestTopo]);
  });
});

describe('adk publish — fluxo de token do registry', () => {
  it('pede o token ao realm do challenge com o service do challenge e scope push,pull do repositório do componente', async () => {
    await publicar();
    expect(pedidosDeToken).toEqual([
      {
        authorization: `Bearer ${ADK_TOKEN}`,
        service: SERVICE,
        scopes: [`repository:${REPO}:push,pull`],
      },
    ]);
  });

  it('todo upload e PUT de manifest vai com o token emitido pelo Hub', async () => {
    await publicar();
    const autorizacoes = [...new Set(pushes().map((p) => p.authorization))];
    expect({ total: pushes().length > 0, autorizacoes }).toEqual({
      total: true,
      autorizacoes: [`Bearer ${registryToken}`],
    });
  });

  it('nunca manda o token do ADK ao registry', async () => {
    await publicar();
    const vazados = pedidosAoRegistry.filter((p) => (p.authorization ?? '').includes(ADK_TOKEN));
    expect({ empurrou: pushes().length > 0, vazados }).toEqual({ empurrou: true, vazados: [] });
  });

  it('usa o access token do usuário logado (credencial do adk login) quando não há ADK_TOKEN', async () => {
    const configDir = join(raiz, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'credentials.json'),
      JSON.stringify({
        [HUB]: {
          client_id: 'c1',
          redirect_uri: 'http://127.0.0.1/cb',
          refresh_token: 'r1',
          access_token: ADK_TOKEN,
          expires_at: Date.now() + 3_600_000,
          user: 'autor@cliente.test',
        },
      }),
    );
    const r = await publicar([], { ADK_TOKEN: undefined, ADK_CONFIG_DIR: configDir });
    expect({ exitCode: r.exitCode, auth: pedidosDeToken.map((p) => p.authorization) }).toEqual({
      exitCode: 0,
      auth: [`Bearer ${ADK_TOKEN}`],
    });
  });
});

describe('adk publish — recusa do Hub (sem papel na org do manifesto)', () => {
  const casos: Array<[string, AccessItem[]]> = [
    ['access vazio', []],
    ['só pull, sem push', [{ type: 'repository', name: REPO, actions: ['pull'] }]],
    [
      'push concedido para OUTRO repositório',
      [{ type: 'repository', name: 'simplafy-tec/outro-satelite', actions: ['push', 'pull'] }],
    ],
  ];

  it.each(casos)('%s → recusa explícita em pt-BR citando o papel ADMIN e o repositório', async (_nome, access) => {
    accessConcedido = access;
    const r = await publicar();
    expect({ exitCode: r.exitCode === 0, admin: /ADMIN/.test(r.stderr), repo: r.stderr.includes(REPO) }).toEqual({
      exitCode: false,
      admin: true,
      repo: true,
    });
  });

  it.each(casos)('%s → pede o token e não tenta push nenhum', async (_nome, access) => {
    accessConcedido = access;
    await publicar();
    expect({ tokens: pedidosDeToken.length, pushes: pushes() }).toEqual({ tokens: 1, pushes: [] });
  });

  it('a recusa não vaza stack trace nem código de erro do registry', async () => {
    accessConcedido = [];
    const r = await publicar();
    expect({
      recusou: /ADMIN/.test(r.stderr),
      stack: SEM_STACK.test(r.stderr + r.stdout),
      registry: /UNAUTHORIZED|DENIED|authentication required/.test(r.stderr + r.stdout),
    }).toEqual({ recusou: true, stack: false, registry: false });
  });

  it('a recusa deixa o manifest.yaml intacto', async () => {
    accessConcedido = [];
    const antes = readFileSync(join(componente, 'manifest.yaml'), 'utf8');
    await publicar();
    expect({
      tokens: pedidosDeToken.length,
      manifesto: readFileSync(join(componente, 'manifest.yaml'), 'utf8'),
    }).toEqual({ tokens: 1, manifesto: antes });
  });
});

describe('adk publish — registry que ainda não aceita o token do Hub (challenge Basic)', () => {
  beforeEach(() => {
    challenge = 'basic';
  });

  it('falha dizendo que o registry ainda não aceita o token do Hub', async () => {
    const r = await publicar();
    expect({
      exitCode: r.exitCode === 0,
      msg: /não aceita o token do Hub/i.test(r.stderr),
      numeroDeStory: /\d+\.\d+\.\d+\.\d+|Hub#/.test(r.stderr),
    }).toEqual({ exitCode: false, msg: true, numeroDeStory: false });
  });

  it('não pede usuário nem senha, nem num terminal', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    stdin.write('robo\nsenha-do-robo\n');
    const pendente = stdin.readableLength;
    const r = await publicar([], {}, { stdin });
    expect({
      recusou: /não aceita o token do Hub/i.test(r.stderr),
      lido: stdin.readableLength,
      prompt: /(senha|password|usu[aá]rio|username)\s*:/i.test(r.stderr + r.stdout),
    }).toEqual({ recusou: true, lido: pendente, prompt: false });
  });

  it('não pede token ao Hub, não empurra nada e não mexe no manifest.yaml', async () => {
    const antes = readFileSync(join(componente, 'manifest.yaml'), 'utf8');
    await publicar();
    expect({
      consultouRegistry: pedidosAoRegistry.length > 0,
      tokens: pedidosDeToken.length,
      pushes: pushes().length,
      manifesto: readFileSync(join(componente, 'manifest.yaml'), 'utf8'),
    }).toEqual({ consultouRegistry: true, tokens: 0, pushes: 0, manifesto: antes });
  });
});

describe('adk publish — credencial e Hub', () => {
  it('sem login e sem ADK_TOKEN, falha com o erro padrão de credencial e não pede token', async () => {
    const r = await publicar([], { ADK_TOKEN: undefined, ADK_CONFIG_DIR: join(raiz, 'sem-login') });
    expect({
      exitCode: r.exitCode === 0,
      msg: /Sem credencial.*adk login/.test(r.stderr),
      tokens: pedidosDeToken.length,
      pushes: pushes().length,
    }).toEqual({ exitCode: false, msg: true, tokens: 0, pushes: 0 });
  });

  it('perfil desconhecido é recusado como pré-condição (exit 2), sem construir', async () => {
    const r = await publicar([], { ADK_PROFILE: 'homolog' });
    expect({ exitCode: r.exitCode, msg: r.stderr.includes('Perfil desconhecido'), build: docker.chamadas() }).toEqual({
      exitCode: 2,
      msg: true,
      build: '',
    });
  });

  it('perfil que contradiz o host de ADK_HUB_URL é recusado (exit 2), sem construir', async () => {
    const r = await publicar([], {
      ADK_HUB_URL: 'https://api-hub-v2-staging.simplafy.com.br',
      ADK_PROFILE: 'prod',
    });
    expect({ exitCode: r.exitCode, build: docker.chamadas() }).toEqual({ exitCode: 2, build: '' });
  });
});

describe('adk publish — recusa local antes de construir', () => {
  it('componente que não é kind: mcp é recusado sem docker build', async () => {
    writeFileSync(join(componente, 'manifest.yaml'), manifestoMcp({ kind: 'tool' }));
    const r = await publicar();
    expect({
      exitCode: r.exitCode === 0,
      msg: r.stderr.includes('kind: mcp'),
      build: docker.chamadas(),
      registry: pedidosAoRegistry.length,
    }).toEqual({ exitCode: false, msg: true, build: '', registry: 0 });
  });

  it.each(['simplafy-crm', 'sol-agenda', 'hub-ponte', 'adk-teste', 'simplafy', 'hub', 'adk', 'registry', 'library'])(
    'slug reservado da plataforma (%s) é recusado sem docker build',
    async (slug) => {
      writeFileSync(join(componente, 'manifest.yaml'), manifestoMcp({ slug }));
      const r = await publicar();
      expect({
        exitCode: r.exitCode === 0,
        msg: r.stderr.includes(slug) && /reservad/i.test(r.stderr),
        build: docker.chamadas(),
        tokens: pedidosDeToken.length,
      }).toEqual({ exitCode: false, msg: true, build: '', tokens: 0 });
    },
  );

  it('diretório sem manifest.yaml é recusado sem docker build', async () => {
    rmSync(join(componente, 'manifest.yaml'));
    const r = await publicar();
    expect({ exitCode: r.exitCode === 0, msg: r.stderr.includes('manifest.yaml'), build: docker.chamadas() }).toEqual({
      exitCode: false,
      msg: true,
      build: '',
    });
  });
});

describe('adk publish — falha do docker build', () => {
  it('build que falha encerra com erro, sem push e sem mexer no manifest.yaml', async () => {
    docker = instalarDockerFalso(raiz, imagem.tar, { falharBuild: true });
    const antes = readFileSync(join(componente, 'manifest.yaml'), 'utf8');
    const r = await publicar();
    expect({
      exitCode: r.exitCode === 0,
      construiu: docker.chamadas().split('\n').some((l) => l.startsWith('build')),
      pushes: pushes().length,
      manifesto: readFileSync(join(componente, 'manifest.yaml'), 'utf8'),
    }).toEqual({ exitCode: false, construiu: true, pushes: 0, manifesto: antes });
  });
});

describe('adk publish — registry de destino', () => {
  const LOCAL = 'http://127.0.0.1:5999';
  let pingsEm: string[] = [];

  beforeEach(() => {
    pingsEm = [];
    // Registry local que ainda é Basic: basta para provar QUAL host a CLI procurou.
    server.use(
      http.all(`${LOCAL}/*`, ({ request }) => {
        pingsEm.push(new URL(request.url).origin);
        return HttpResponse.json(
          { errors: [{ code: 'UNAUTHORIZED' }] },
          { status: 401, headers: { 'www-authenticate': 'Basic realm="Registry Realm"' } },
        );
      }),
    );
  });

  function semFlag(env: Record<string, string | undefined>) {
    return runCli(['publish', '--dir', componente], {
      cwd: raiz,
      env: { ADK_HUB_URL: HUB, ADK_TOKEN, PATH: docker.PATH, ...env },
    });
  }

  it('--registry ganha de ADK_REGISTRY_URL', async () => {
    const r = await runCli(['publish', '--dir', componente, '--registry', REGISTRY], {
      cwd: raiz,
      env: { ADK_HUB_URL: HUB, ADK_TOKEN, PATH: docker.PATH, ADK_REGISTRY_URL: LOCAL },
    });
    expect({
      exitCode: r.exitCode,
      local: pingsEm,
      linha: linhaImage(readFileSync(join(componente, 'manifest.yaml'), 'utf8')),
    }).toEqual({ exitCode: 0, local: [], linha: `image: ${REGISTRY_HOST}/${REPO}@${imagem.digestTopo}` });
  });

  it('sem --registry, usa ADK_REGISTRY_URL', async () => {
    await semFlag({ ADK_REGISTRY_URL: LOCAL });
    expect({ hosts: [...new Set(pingsEm)], padrao: pedidosAoRegistry.length }).toEqual({
      hosts: [LOCAL],
      padrao: 0,
    });
  });

  it('sem --registry e sem ADK_REGISTRY_URL, publica em https://registry.simplafy.com.br', async () => {
    const r = await semFlag({ ADK_REGISTRY_URL: undefined });
    expect({
      exitCode: r.exitCode,
      local: pingsEm,
      linha: linhaImage(readFileSync(join(componente, 'manifest.yaml'), 'utf8')),
    }).toEqual({ exitCode: 0, local: [], linha: `image: ${REGISTRY_HOST}/${REPO}@${imagem.digestTopo}` });
  });
});

describe('adk publish — allowlist de registry e esquema', () => {
  let pedidosForaDaLista: string[] = [];

  beforeEach(() => {
    pedidosForaDaLista = [];
    const anotar = ({ request }: { request: Request }) => {
      pedidosForaDaLista.push(`${request.method} ${request.url}`);
      return respostaDeChallenge();
    };
    server.use(
      ...[
        'https://registry.exemplo.com.br',
        'http://registry.exemplo.com.br',
        'http://x.test',
        'https://x.test',
        'http://registry.simplafy.com.br',
      ].map((origem) => http.all(`${origem}/*`, anotar)),
    );
  });

  it.each([
    'https://registry.exemplo.com.br',
    'http://registry.exemplo.com.br',
    'http://x.test',
    'https://x.test',
    'http://registry.simplafy.com.br',
  ])('%s → recusa como pré-condição (exit 2), sem falar com ele nem com o Hub e sem construir', async (registry) => {
    const r = await runCli(['publish', '--dir', componente, '--registry', registry], {
      cwd: raiz,
      env: { ADK_HUB_URL: HUB, ADK_TOKEN, PATH: docker.PATH },
    });
    expect({
      exitCode: r.exitCode,
      citaRegistry: r.stderr.includes(new URL(registry).host),
      pedidos: pedidosForaDaLista,
      tokens: pedidosDeToken.length,
      build: docker.chamadas(),
    }).toEqual({ exitCode: 2, citaRegistry: true, pedidos: [], tokens: 0, build: '' });
  });

  it.each(['http://127.0.0.1:5995', 'http://localhost:5994'])(
    'registry local em http (%s) é aceito e consultado',
    async (registry) => {
      const pings: string[] = [];
      server.use(
        http.all(`${registry}/*`, ({ request }) => {
          pings.push(new URL(request.url).pathname);
          return HttpResponse.json(
            { errors: [{ code: 'UNAUTHORIZED' }] },
            { status: 401, headers: { 'www-authenticate': 'Basic realm="Registry Realm"' } },
          );
        }),
      );
      await runCli(['publish', '--dir', componente, '--registry', registry], {
        cwd: raiz,
        env: { ADK_HUB_URL: HUB, ADK_TOKEN, PATH: docker.PATH },
      });
      expect(pings.length > 0).toBe(true);
    },
  );
});

describe('adk publish — realm do challenge fora da origem do Hub', () => {
  let pedidosAoRealmEstranho: { url: string; authorization: string | null }[] = [];

  beforeEach(() => {
    pedidosAoRealmEstranho = [];
  });

  it.each([
    ['outro host', 'http://outro-hub.test/api/v1/adk/registry/token'],
    ['mesmo host, outra porta', 'http://hub-mock.test:8443/api/v1/adk/registry/token'],
    ['mesmo host, outro esquema', 'https://hub-mock.test/api/v1/adk/registry/token'],
  ])('%s → recusa explícita, sem pedido ao realm e sem mandar o bearer do ADK', async (_nome, realm) => {
    realmDoChallenge = realm;
    server.use(
      http.get(realm, ({ request }) => {
        pedidosAoRealmEstranho.push({
          url: request.url,
          authorization: request.headers.get('authorization'),
        });
        registryToken = registryJwt(accessConcedido);
        return HttpResponse.json({ token: registryToken, access_token: registryToken, expires_in: 300 });
      }),
    );
    const antes = readFileSync(join(componente, 'manifest.yaml'), 'utf8');
    const r = await publicar();
    expect({
      exitCode: r.exitCode === 0,
      citaRealm: r.stderr.includes(new URL(realm).origin),
      pedidosAoRealm: pedidosAoRealmEstranho,
      pedidosAoHub: pedidosDeToken.length,
      pushes: pushes().length,
      manifesto: readFileSync(join(componente, 'manifest.yaml'), 'utf8'),
    }).toEqual({
      exitCode: false,
      citaRealm: true,
      pedidosAoRealm: [],
      pedidosAoHub: 0,
      pushes: 0,
      manifesto: antes,
    });
  });
});

describe('adk publish — manifest.yaml sem a chave image', () => {
  it('acrescenta image: com o digest, preservando comentários e o resto do arquivo', async () => {
    const original = manifestoMcp()
      .split('\n')
      .filter((l) => !l.startsWith('image:'))
      .join('\n');
    writeFileSync(join(componente, 'manifest.yaml'), original);
    const r = await publicar();
    const depois = readFileSync(join(componente, 'manifest.yaml'), 'utf8');
    const linhasImage = depois.split('\n').filter((l) => l.startsWith('image:'));
    expect({
      exitCode: r.exitCode,
      linhasImage,
      resto: depois
        .split('\n')
        .filter((l) => !l.startsWith('image:'))
        .join('\n'),
      image: (parse(depois) as { image?: string }).image,
    }).toEqual({
      exitCode: 0,
      linhasImage: [`image: ${REGISTRY_HOST}/${REPO}@${imagem.digestTopo}`],
      resto: original,
      image: `${REGISTRY_HOST}/${REPO}@${imagem.digestTopo}`,
    });
  });
});

describe('adk publish — ambiente do docker', () => {
  const DOCKER_ENV = {
    DOCKER_HOST: 'unix:///tmp/adk-teste-docker.sock',
    DOCKER_CONTEXT: 'contexto-de-teste',
    DOCKER_CONFIG: '/tmp/adk-teste-docker-config',
  };

  it('DOCKER_HOST, DOCKER_CONTEXT e DOCKER_CONFIG chegam a toda chamada do docker; a credencial do ADK não', async () => {
    await publicar([], DOCKER_ENV);
    const chamadas = docker.chamadas().trim().split('\n').filter(Boolean).length;
    const ambiente = docker.ambiente().split('\n');
    const vezes = (linha: string) => ambiente.filter((l) => l === linha).length;
    expect({
      chamadasMinimas: chamadas >= 2,
      host: vezes(`DOCKER_HOST=${DOCKER_ENV.DOCKER_HOST}`),
      contexto: vezes(`DOCKER_CONTEXT=${DOCKER_ENV.DOCKER_CONTEXT}`),
      config: vezes(`DOCKER_CONFIG=${DOCKER_ENV.DOCKER_CONFIG}`),
      vazou: docker.ambiente().includes(ADK_TOKEN),
    }).toEqual({ chamadasMinimas: true, host: chamadas, contexto: chamadas, config: chamadas, vazou: false });
  });

  it('com DOCKER_HOST tcp+TLS, DOCKER_TLS_VERIFY e DOCKER_CERT_PATH chegam ao docker build e ao docker save', async () => {
    const TLS = {
      DOCKER_HOST: 'tcp://docker-remoto.test:2376',
      DOCKER_TLS_VERIFY: '1',
      DOCKER_CERT_PATH: '/tmp/adk-teste-docker-certs',
    };
    await publicar([], TLS);
    const chamadas = docker.chamadas().trim().split('\n').filter(Boolean);
    const ambiente = docker.ambiente().split('\n');
    const vezes = (linha: string) => ambiente.filter((l) => l === linha).length;
    expect({
      comandos: chamadas.map((c) => c.split(' ')[0]),
      host: vezes(`DOCKER_HOST=${TLS.DOCKER_HOST}`),
      verificacao: vezes(`DOCKER_TLS_VERIFY=${TLS.DOCKER_TLS_VERIFY}`),
      certificados: vezes(`DOCKER_CERT_PATH=${TLS.DOCKER_CERT_PATH}`),
    }).toEqual({ comandos: ['build', 'save'], host: 2, verificacao: 2, certificados: 2 });
  });
});

describe('adk publish — plataforma da imagem', () => {
  /** Valores de `--platform` (separado ou com `=`) que o `docker build` recebeu. */
  function plataformasDoBuild(): string[] {
    const build = docker
      .chamadas()
      .split('\n')
      .find((l) => l.startsWith('build '));
    const args = (build ?? '').split(' ');
    return args.flatMap((arg, i) => {
      if (arg === '--platform') return [args[i + 1] ?? ''];
      if (arg.startsWith('--platform=')) return [arg.slice('--platform='.length)];
      return [];
    });
  }

  it('sem --platform, o docker build constrói para linux/amd64, a arquitetura dos nós do cluster', async () => {
    const r = await publicar();
    expect({ exitCode: r.exitCode, plataformas: plataformasDoBuild() }).toEqual({
      exitCode: 0,
      plataformas: ['linux/amd64'],
    });
  });

  it('--platform sobrescreve o padrão: o docker build recebe só a plataforma pedida', async () => {
    const r = await publicar(['--platform', 'linux/arm64']);
    expect({ exitCode: r.exitCode, plataformas: plataformasDoBuild() }).toEqual({
      exitCode: 0,
      plataformas: ['linux/arm64'],
    });
  });

  it('a ajuda do publish documenta a flag --platform com o padrão linux/amd64', async () => {
    const r = await runCli(['publish', '--help'], { cwd: raiz });
    expect(r.stdout).toMatch(/--platform <[^>]+>[\s\S]*linux\/amd64/);
  });
});

describe('adk publish — gravação do image: no manifest.yaml', () => {
  const imagemEsperada = () => `${REGISTRY_HOST}/${REPO}@${imagem.digestTopo}`;
  const manifestoAtual = () => readFileSync(join(componente, 'manifest.yaml'), 'utf8');

  function comImage(linhaOuBloco: string): string {
    return manifestoMcp().replace(/^image:.*$/m, linhaOuBloco);
  }

  it('image: vazio com comentário vira a imagem, sem engolir o comentário no valor', async () => {
    writeFileSync(join(componente, 'manifest.yaml'), comImage('image: # preenchido pelo adk publish'));
    const r = await publicar();
    const depois = manifestoAtual();
    expect({
      exitCode: r.exitCode,
      image: (parse(depois) as { image?: unknown }).image,
      comentario: depois.includes('# preenchido pelo adk publish'),
    }).toEqual({ exitCode: 0, image: imagemEsperada(), comentario: true });
  });

  it.each([
    ['aspas duplas', 'image: "TROQUE"'],
    ['aspas simples', "image: 'TROQUE'"],
  ])('image: entre %s vira a imagem e o resto do arquivo não muda', async (_nome, linha) => {
    const antes = comImage(linha);
    writeFileSync(join(componente, 'manifest.yaml'), antes);
    const r = await publicar();
    const depois = manifestoAtual();
    const semImage = (t: string) => t.split('\n').filter((l) => !l.startsWith('image:')).join('\n');
    expect({
      exitCode: r.exitCode,
      image: (parse(depois) as { image?: unknown }).image,
      resto: semImage(depois),
    }).toEqual({ exitCode: 0, image: imagemEsperada(), resto: semImage(antes) });
  });

  it('image: em bloco (|) é recusado antes do build com exit 2 — "não é um valor simples"', async () => {
    const antes = comImage('image: |\n  ghcr.io/simplafy-tec/demo-satelite@sha256:abc');
    writeFileSync(join(componente, 'manifest.yaml'), antes);
    const r = await publicar();
    expect({
      exitCode: r.exitCode,
      msg: r.stderr.includes('não é um valor simples'),
      build: docker.chamadas(),
      tokens: pedidosDeToken.length,
      manifesto: manifestoAtual(),
    }).toEqual({ exitCode: 2, msg: true, build: '', tokens: 0, manifesto: antes });
  });

  it('não deixa arquivo temporário no diretório do componente', async () => {
    const antes = readdirSync(componente).sort();
    await publicar();
    expect(readdirSync(componente).sort()).toEqual(antes);
  });

  it.skipIf(process.getuid?.() === 0)(
    'gravação que falha deixa o manifest.yaml intacto, sem temporário, e o digest já saiu no stdout',
    async () => {
      const antes = manifestoAtual();
      const arquivos = readdirSync(componente).sort();
      const modo = statSync(componente).mode;
      // Diretório sem escrita: a gravação atômica (temporário + rename) não tem onde nascer.
      docker = instalarDockerFalso(raiz, imagem.tar, { aoConstruir: `chmod 555 '${componente}'` });
      try {
        const r = await publicar();
        expect({
          exitCode: r.exitCode === 0,
          digestNoStdout: r.stdout.includes(imagem.digestTopo),
          manifesto: manifestoAtual(),
          arquivos: readdirSync(componente).sort(),
        }).toEqual({ exitCode: false, digestNoStdout: true, manifesto: antes, arquivos });
      } finally {
        chmodSync(componente, modo);
      }
    },
  );

  it('relê o manifest.yaml na hora de gravar: mudança do autor durante o build em outra chave é preservada', async () => {
    const arquivo = join(componente, 'manifest.yaml');
    docker = instalarDockerFalso(raiz, imagem.tar, {
      aoConstruir: `sed -i 's/^name: Demo satélite$/name: Demo renomeado durante o build/' '${arquivo}'`,
    });
    const r = await publicar();
    const depois = parse(manifestoAtual()) as { name?: unknown; image?: unknown };
    expect({ exitCode: r.exitCode, name: depois.name, image: depois.image }).toEqual({
      exitCode: 0,
      name: 'Demo renomeado durante o build',
      image: imagemEsperada(),
    });
  });
});

describe('adk publish — integridade do push', () => {
  it('Location de upload em outra origem: nenhum pedido chega lá e o publish falha', async () => {
    const estrangeiros: { url: string; authorization: string | null }[] = [];
    localDeUploadEstrangeiro = 'https://upload.estrangeiro.test/v2/uploads/1';
    server.use(
      http.all('https://upload.estrangeiro.test/*', ({ request }) => {
        estrangeiros.push({ url: request.url, authorization: request.headers.get('authorization') });
        return new HttpResponse(null, { status: 201 });
      }),
    );
    const antes = readFileSync(join(componente, 'manifest.yaml'), 'utf8');
    const r = await publicar();
    expect({
      exitCode: r.exitCode === 0,
      estrangeiros,
      manifesto: readFileSync(join(componente, 'manifest.yaml'), 'utf8'),
    }).toEqual({ exitCode: false, estrangeiros: [], manifesto: antes });
  });

  it('blob adulterado no tar (sha não confere): falha sem empurrar nada', async () => {
    imagem = montarImagemOci(join(raiz, 'oci-adulterado'), { aninhado: false, adulterarCamada: true });
    docker = instalarDockerFalso(raiz, imagem.tar);
    const r = await publicar();
    expect({
      exitCode: r.exitCode === 0,
      tokens: pedidosDeToken.length,
      pushes: pushes(),
      stack: SEM_STACK.test(r.stderr),
    }).toEqual({ exitCode: false, tokens: 1, pushes: [], stack: false });
  });

  it('Docker-Content-Digest divergente na resposta do manifest: falha e não grava o manifest.yaml', async () => {
    digestDivergente = true;
    const antes = readFileSync(join(componente, 'manifest.yaml'), 'utf8');
    const r = await publicar();
    expect({
      exitCode: r.exitCode === 0,
      tentouManifesto: pedidosAoRegistry.some((p) => p.method === 'PUT' && p.path.includes('/manifests/')),
      manifesto: readFileSync(join(componente, 'manifest.yaml'), 'utf8'),
    }).toEqual({ exitCode: false, tentouManifesto: true, manifesto: antes });
  });

  it('cabeçalho do tar com tamanho além do arquivo: erro claro, sem alocar o tamanho declarado', async () => {
    const tar = readFileSync(imagem.tar);
    // Acha o cabeçalho do index.json e declara 512 MiB nele, com o checksum refeito.
    let cabecalho = -1;
    for (let pos = 0; pos + 512 <= tar.length; pos += 512) {
      if (tar.subarray(pos, pos + 100).toString('utf8').replace(/\0.*$/s, '') === 'index.json') {
        cabecalho = pos;
        break;
      }
    }
    expect(cabecalho).toBeGreaterThanOrEqual(0);
    const declarado = 512 * 1024 * 1024;
    tar.write(`${declarado.toString(8).padStart(11, '0')}\0`, cabecalho + 124, 12, 'ascii');
    tar.fill(0x20, cabecalho + 148, cabecalho + 156);
    let soma = 0;
    for (let i = cabecalho; i < cabecalho + 512; i++) soma += tar[i];
    tar.write(`${soma.toString(8).padStart(6, '0')}\0 `, cabecalho + 148, 8, 'ascii');
    writeFileSync(imagem.tar, tar);

    const tamanhos: number[] = [];
    const espioes = (['alloc', 'allocUnsafe', 'allocUnsafeSlow'] as const).map((nome) => {
      const original = Buffer[nome].bind(Buffer) as (n: number, ...resto: unknown[]) => Buffer;
      return vi.spyOn(Buffer, nome).mockImplementation(((n: number, ...resto: unknown[]) => {
        tamanhos.push(n);
        return original(n, ...resto);
      }) as never);
    });
    try {
      const r = await publicar();
      expect({
        exitCode: r.exitCode === 0,
        msg: /tar/i.test(r.stderr),
        alocacaoGigante: tamanhos.some((n) => n >= declarado),
        pushes: pushes().length,
      }).toEqual({ exitCode: false, msg: true, alocacaoGigante: false, pushes: 0 });
    } finally {
      for (const e of espioes) e.mockRestore();
    }
  });
});

describe('adk publish — pedido ao realm', () => {
  it('não segue redirect do realm: nenhum pedido chega ao destino do redirect e o publish falha', async () => {
    const redirecionados: { url: string; authorization: string | null }[] = [];
    server.use(
      http.get(REALM, () =>
        new HttpResponse(null, { status: 302, headers: { location: 'https://desvio.test/token' } }),
      ),
      http.get('https://desvio.test/token', ({ request }) => {
        redirecionados.push({ url: request.url, authorization: request.headers.get('authorization') });
        registryToken = registryJwt(accessConcedido);
        return HttpResponse.json({ token: registryToken, access_token: registryToken, expires_in: 300 });
      }),
    );
    const r = await publicar();
    expect({ exitCode: r.exitCode === 0, redirecionados, pushes: pushes().length }).toEqual({
      exitCode: false,
      redirecionados: [],
      pushes: 0,
    });
  });
});

describe('adk publish — tag de retenção', () => {
  let tzOriginal: string | undefined;
  beforeEach(() => {
    tzOriginal = process.env.TZ;
    // Fuso fora de UTC: a tag tem que sair em UTC mesmo assim.
    process.env.TZ = 'America/Sao_Paulo';
  });
  afterEach(() => {
    if (tzOriginal === undefined) delete process.env.TZ;
    else process.env.TZ = tzOriginal;
  });

  it('empurra o manifesto de topo também com a tag adk-<AAAAMMDDhhmmss> em UTC, e o image: segue por digest', async () => {
    const inicio = Math.floor(Date.now() / 1000) * 1000;
    const r = await publicar();
    const fim = Date.now();
    const tags = [...tagsNoRegistry.entries()];
    const [tag, digestDaTag] = tags[0] ?? ['', ''];
    const m = /^adk-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(tag);
    const instante = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
    expect({
      exitCode: r.exitCode,
      tags: tags.length,
      formato: m !== null,
      emUtc: instante >= inicio && instante <= fim,
      digestDaTag,
      linha: linhaImage(readFileSync(join(componente, 'manifest.yaml'), 'utf8')),
    }).toEqual({
      exitCode: 0,
      tags: 1,
      formato: true,
      emUtc: true,
      digestDaTag: imagem.digestTopo,
      linha: `image: ${REGISTRY_HOST}/${REPO}@${imagem.digestTopo}`,
    });
  });

  it('no layout aninhado, a tag aponta o índice de topo, não o manifesto da plataforma', async () => {
    imagem = montarImagemOci(join(raiz, 'oci-aninhado-tag'), { aninhado: true });
    docker = instalarDockerFalso(raiz, imagem.tar);
    await publicar();
    expect([...tagsNoRegistry.values()]).toEqual([imagem.digestTopo]);
  });
});

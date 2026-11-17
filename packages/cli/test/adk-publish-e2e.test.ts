import { createSign, randomUUID, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

// Prova de ponta a ponta do `adk publish` contra um registry de verdade:
// `registry:3` (CNCF Distribution, o mesmo do registry.simplafy.com.br) em
// container com `auth.token`, e um Hub falso local que assina o JWT RS256 com
// um certificado gerado aqui. O `docker build` é real (imagem `FROM scratch`,
// sem pull de base).
//
// Precisa de `docker` com daemon acessível e de `openssl`. Sem eles a suíte é
// pulada; para pular de propósito numa máquina que tem docker:
//   ADK_SKIP_DOCKER_E2E=1 corepack pnpm test

function disponivel(comando: string, args: string[]): boolean {
  try {
    execFileSync(comando, args, { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const PULAR =
  process.env.ADK_SKIP_DOCKER_E2E === '1' ||
  !disponivel('docker', ['info']) ||
  !disponivel('openssl', ['version']);

const SERVICE = 'registry-e2e';
const ISSUER = 'hub-e2e';
const ADK_TOKEN = 'adk-e2e-token';
const SLUG = 'satelite-e2e';
const REPO = `simplafy-tec/${SLUG}`;

interface AccessItem {
  type: 'repository';
  name: string;
  actions: string[];
}

/** Mesmo formato do `RegistryTokenService` do Hub (fixture `registry-token-contract.json`). */
function assinarJwt(chavePem: string, x5c: string[], access: AccessItem[]): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  const entrada = `${b64({ alg: 'RS256', typ: 'JWT', x5c })}.${b64({
    iss: ISSUER,
    sub: 'user-e2e',
    aud: SERVICE,
    iat,
    nbf: iat,
    exp: iat + 300,
    jti: randomUUID(),
    access,
  })}`;
  return `${entrada}.${createSign('RSA-SHA256').update(entrada).end().sign(chavePem, 'base64url')}`;
}

/** Parse do `scope=repository:<name>:<acoes>` como o Hub faz. */
function accessDoScope(scope: string): AccessItem | null {
  const primeiro = scope.indexOf(':');
  const ultimo = scope.lastIndexOf(':');
  if (primeiro === -1 || ultimo === primeiro) return null;
  return {
    type: 'repository',
    name: scope.slice(primeiro + 1, ultimo),
    actions: scope.slice(ultimo + 1).split(','),
  };
}

async function esperarRegistry(base: string): Promise<void> {
  const limite = Date.now() + 30_000;
  for (;;) {
    try {
      const r = await fetch(`${base}/v2/`);
      if (r.status === 401) return;
    } catch {
      // ainda subindo
    }
    if (Date.now() > limite) throw new Error(`registry não respondeu em ${base}`);
    await new Promise((resolver) => setTimeout(resolver, 150));
  }
}

describe.skipIf(PULAR)('adk publish — ponta a ponta contra registry:3 com auth.token', () => {
  let raiz: string;
  let componente: string;
  let container = '';
  let registryUrl = '';
  let hub: Server;
  let hubUrl = '';
  let chavePem = '';
  let x5c: string[] = [];

  beforeAll(async () => {
    raiz = mkdtempSync(join(tmpdir(), 'adk-publish-e2e-'));
    const certs = join(raiz, 'certs');
    mkdirSync(certs, { recursive: true });
    chmodSync(raiz, 0o755);
    chmodSync(certs, 0o755);
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${ISSUER}`, '-days', '1',
        '-keyout', join(certs, 'key.pem'), '-out', join(certs, 'root.crt'),
      ],
      { stdio: 'ignore' },
    );
    chmodSync(join(certs, 'root.crt'), 0o644);
    chavePem = readFileSync(join(certs, 'key.pem'), 'utf8');
    const certPem = readFileSync(join(certs, 'root.crt'), 'utf8');
    new X509Certificate(certPem);
    x5c = [certPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')];

    // Hub falso: só o bearer do ADK abre a porta; concede o que o scope pede.
    hub = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/api/v1/adk/registry/token') {
        res.writeHead(404).end();
        return;
      }
      if (req.headers.authorization !== `Bearer ${ADK_TOKEN}`) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"message":"Unauthorized"}');
        return;
      }
      if (url.searchParams.get('service') !== SERVICE) {
        res.writeHead(400, { 'content-type': 'application/json' }).end('{"message":"service"}');
        return;
      }
      const access = url.searchParams
        .getAll('scope')
        .map(accessDoScope)
        .filter((a): a is AccessItem => a !== null);
      const token = assinarJwt(chavePem, x5c, access);
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          JSON.stringify({ token, access_token: token, expires_in: 300, issued_at: new Date().toISOString() }),
        );
    });
    await new Promise<void>((resolver) => hub.listen(0, '127.0.0.1', resolver));
    hubUrl = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;

    const config = join(raiz, 'config.yml');
    writeFileSync(
      config,
      [
        'version: 0.1',
        'log:',
        '  level: warn',
        'storage:',
        '  filesystem:',
        '    rootdirectory: /var/lib/registry',
        'http:',
        '  addr: ":5000"',
        'auth:',
        '  token:',
        `    realm: ${hubUrl}/api/v1/adk/registry/token`,
        `    service: ${SERVICE}`,
        `    issuer: ${ISSUER}`,
        '    rootcertbundle: /etc/distribution/root.crt',
        '',
      ].join('\n'),
    );
    chmodSync(config, 0o644);
    container = execFileSync('docker', [
      'run', '-d', '--rm', '-p', '127.0.0.1::5000',
      '-v', `${config}:/etc/distribution/config.yml:ro`,
      '-v', `${join(certs, 'root.crt')}:/etc/distribution/root.crt:ro`,
      'registry:3',
    ])
      .toString()
      .trim();
    const porta = execFileSync('docker', ['port', container, '5000/tcp'])
      .toString()
      .trim()
      .split('\n')[0]
      .split(':')
      .pop();
    registryUrl = `http://127.0.0.1:${porta}`;
    await esperarRegistry(registryUrl);

    componente = join(raiz, SLUG);
    mkdirSync(componente, { recursive: true });
    writeFileSync(join(componente, 'Dockerfile'), 'FROM scratch\nCOPY server.py /server.py\n');
    writeFileSync(join(componente, 'server.py'), `print("${randomUUID()}")\n`);
    writeFileSync(
      join(componente, 'manifest.yaml'),
      [
        'spec_version: v1',
        'kind: mcp',
        `slug: ${SLUG}`,
        `name: ${SLUG}`,
        '# Imagem do satélite POR DIGEST — tag é mutável e o Hub não aceita.',
        `image: TROQUE — ghcr.io/simplafy-tec/${SLUG}@sha256:<64 hex>`,
        'url: https://satelite.example/mcp',
        'tools: []',
        '',
      ].join('\n'),
    );
  }, 180_000);

  afterAll(async () => {
    if (container) {
      try {
        execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
      } catch {
        // container já saiu (--rm)
      }
    }
    await new Promise<void>((resolver) => (hub ? hub.close(() => resolver()) : resolver()));
    if (raiz) rmSync(raiz, { recursive: true, force: true });
  });

  async function tokenPara(repo: string): Promise<string> {
    const r = await fetch(
      `${hubUrl}/api/v1/adk/registry/token?service=${SERVICE}&scope=${encodeURIComponent(`repository:${repo}:push,pull`)}`,
      { headers: { authorization: `Bearer ${ADK_TOKEN}` } },
    );
    return ((await r.json()) as { token: string }).token;
  }

  it(
    'publica: o digest impresso existe no registry e o manifest.yaml aponta para ele',
    async () => {
      const r = await runCli(['publish', '--dir', componente, '--registry', registryUrl], {
        cwd: raiz,
        env: { ADK_HUB_URL: hubUrl, ADK_TOKEN },
      });
      const digest = r.stdout.match(/sha256:[0-9a-f]{64}/)?.[0] ?? '';

      const token = await tokenPara(REPO);
      const noRegistry = await fetch(`${registryUrl}/v2/${REPO}/manifests/${digest}`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: [
            'application/vnd.oci.image.index.v1+json',
            'application/vnd.oci.image.manifest.v1+json',
            'application/vnd.docker.distribution.manifest.v2+json',
            'application/vnd.docker.distribution.manifest.list.v2+json',
          ].join(', '),
        },
      });
      const imagemNoArquivo = readFileSync(join(componente, 'manifest.yaml'), 'utf8')
        .split('\n')
        .find((l) => l.startsWith('image:'));

      expect({
        exitCode: r.exitCode,
        status: noRegistry.status,
        digestDoRegistry: noRegistry.headers.get('docker-content-digest'),
        imagemNoArquivo,
      }).toEqual({
        exitCode: 0,
        status: 200,
        digestDoRegistry: digest,
        imagemNoArquivo: `image: ${new URL(registryUrl).host}/${REPO}@${digest}`,
      });
    },
    120_000,
  );

  // As duas abaixo provam o AMBIENTE da prova acima: o registry confere o
  // escopo do JWT (não é um registry aberto), e o token do Hub falso é válido
  // para o repositório certo (a recusa vem do escopo, não de assinatura ruim).
  it('o registry recusa um token emitido para outro slug', async () => {
    const token = await tokenPara('simplafy-tec/outro-satelite');
    const r = await fetch(`${registryUrl}/v2/${REPO}/blobs/uploads/`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(401);
  });

  it('o registry aceita o token emitido para o slug do componente (controle da recusa acima)', async () => {
    const token = await tokenPara(REPO);
    const r = await fetch(`${registryUrl}/v2/${REPO}/blobs/uploads/`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(202);
  });
});

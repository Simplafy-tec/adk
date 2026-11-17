/**
 * `adk publish` — constrói a imagem do satélite (`kind: mcp`), empurra para o
 * registry com o token que o Hub emite e grava o digest no `image:` do
 * `manifest.yaml`.
 *
 * Ordem: recusas locais (kind, slug, arquivo) → autorização no registry (o
 * Hub decide quem pode empurrar) → `docker build` + `docker save` → push →
 * manifesto. Autorizar ANTES do build é o que faz o autor sem papel na org
 * ouvir a recusa em segundos, e não depois de minutos de build.
 */

import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isMap, isScalar, parseDocument, type Document } from 'yaml';
import { executar } from '../exec.js';
import { accessToken } from '../hub.js';
import { hubUrl, type Ctx } from '../ctx.js';
import { LayoutInvalidoError, LayoutOci } from '../oci-layout.js';
import { ClienteRegistry, PublicacaoError } from '../registry.js';

const REGISTRY_PADRAO = 'https://registry.simplafy.com.br';
/**
 * Hosts remotos aceitos — o mesmo `REGISTRIES_PERMITIDOS` do Hub (o apply só
 * aceita `image:` desses). Publicar em outro seria imagem que o Hub recusa, e
 * o bearer do registry entregue a um host qualquer.
 */
const REGISTRIES_REMOTOS = new Set(['registry.simplafy.com.br']);
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);
const NAMESPACE = 'simplafy-tec';

/**
 * Nomes que nenhum componente reivindica — mesma lista do emissor de token do
 * Hub. O namespace `simplafy-tec` é o das imagens de PRODUTO que os clusters
 * puxam; o Hub já nega o push, e recusar aqui poupa o build de quem errou.
 */
const PREFIXOS_RESERVADOS = ['simplafy-', 'sol-', 'hub-', 'adk-'] as const;
const NOMES_RESERVADOS = new Set(['simplafy', 'hub', 'adk', 'registry', 'library']);
const RFC1123_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * O `docker` precisa achar o daemon do autor; nada disso é segredo. A
 * credencial do ADK continua fora (allowlist do `executar`).
 */
const VARIAVEIS_DOCKER = [
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
] as const;
/**
 * A arquitetura dos nós do cluster. Sem fixar, o build sai na do autor (arm64
 * num Mac ARM) e o pod não sobe.
 */
const PLATAFORMA_PADRAO = 'linux/amd64';
const TIMEOUT_BUILD_MS = 30 * 60_000;
const TIMEOUT_SAVE_MS = 10 * 60_000;
const BUFFER_DOCKER_BYTES = 64 * 1024 * 1024;
const LINHAS_DE_ERRO = 30;

class PreCondicaoError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'PreCondicaoError';
  }
}

function nomeReservado(slug: string): boolean {
  return NOMES_RESERVADOS.has(slug) || PREFIXOS_RESERVADOS.some((p) => slug.startsWith(p));
}

/** `--registry` > `ADK_REGISTRY_URL` > registry da Simplafy. */
function resolverRegistry(ctx: Ctx, flag: string | undefined): URL {
  const bruto = (flag ?? ctx.env.ADK_REGISTRY_URL ?? '').trim() || REGISTRY_PADRAO;
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(bruto) ? bruto : `https://${bruto}`);
  } catch {
    throw new PreCondicaoError(`Registry inválido: ${bruto}`);
  }
  if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/, '')) {
    throw new PreCondicaoError(
      `Registry inválido: ${bruto} — informe só a origem (https://<host>[:porta]), sem caminho nem credencial.`,
    );
  }
  const local = LOOPBACK.has(url.hostname);
  if (!local && !REGISTRIES_REMOTOS.has(url.hostname)) {
    throw new PreCondicaoError(
      `Registry não permitido: ${url.host} — o adk publish só publica em ` +
        `${[...REGISTRIES_REMOTOS].join(', ')} ou num registry local (127.0.0.1, [::1], localhost).`,
    );
  }
  // http só onde o tráfego não sai da máquina: o bearer do registry viaja em cada request.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new PreCondicaoError(
      `Registry inválido: ${url.host} em ${url.protocol.replace(':', '')} — use https ` +
        '(http só para registry local, em 127.0.0.1, [::1] ou localhost).',
    );
  }
  return url;
}

interface Manifesto {
  slug: string;
}

function lerManifesto(caminho: string): Manifesto {
  if (!existsSync(caminho)) {
    throw new PreCondicaoError(
      `Não encontrei manifest.yaml em ${caminho} — rode dentro da pasta do componente ou use --dir.`,
    );
  }
  const texto = readFileSync(caminho, 'utf8');
  const documento = parseDocument(texto);
  if (documento.errors.length > 0 || !isMap(documento.contents)) {
    throw new PreCondicaoError(
      'manifest.yaml inválido: o topo do arquivo precisa ser um mapa YAML.',
    );
  }
  const { kind, slug } = documento.toJS() as { kind?: unknown; slug?: unknown };
  if (kind !== 'mcp') {
    throw new PreCondicaoError(
      `adk publish publica a imagem de um satélite: o manifest.yaml precisa ser kind: mcp (é ${String(kind ?? 'ausente')}).`,
    );
  }
  if (typeof slug !== 'string' || !RFC1123_LABEL.test(slug)) {
    throw new PreCondicaoError(
      'O slug do manifest.yaml precisa ser um rótulo DNS: minúsculas, dígitos e hífen, até 63 caracteres.',
    );
  }
  if (nomeReservado(slug)) {
    throw new PreCondicaoError(
      `O slug ${slug} é reservado da plataforma (prefixos ${PREFIXOS_RESERVADOS.join(', ')} e nomes ` +
        `${[...NOMES_RESERVADOS].join(', ')}): renomeie o componente.`,
    );
  }
  if (localizarImagem(documento) === null) throw new PreCondicaoError(MENSAGEM_NAO_SIMPLES);
  return { slug };
}

const MENSAGEM_NAO_SIMPLES =
  'O image: do manifest.yaml não é um valor simples (bloco, lista ou mapa) — deixe-o numa linha só, ' +
  'ou vazio, e rode o adk publish de novo.';

type PosicaoImagem = { tipo: 'ausente' } | { tipo: 'valor'; inicio: number; fim: number };

const ESCALARES_SIMPLES = new Set(['PLAIN', 'QUOTE_DOUBLE', 'QUOTE_SINGLE']);

/** Onde está o valor de `image:` no texto; `null` quando não é um escalar de uma linha. */
function localizarImagem(documento: Document): PosicaoImagem | null {
  const mapa = documento.contents;
  if (!isMap(mapa)) return null;
  const par = mapa.items.find((item) => isScalar(item.key) && item.key.value === 'image');
  if (!par) return { tipo: 'ausente' };
  const valor = par.value;
  if (!isScalar(valor) || !valor.range) return null;
  if (!ESCALARES_SIMPLES.has(String(valor.type))) return null;
  return { tipo: 'valor', inicio: valor.range[0], fim: valor.range[1] };
}

/**
 * Troca só o VALOR de `image:` (pelo intervalo que o parser aponta), sem
 * reserializar o YAML: comentário, ordem e formatação do autor ficam como
 * estavam. Sem a chave, ela entra no fim do arquivo. O resultado é relido e
 * tem que dizer exatamente `image: <imagem>` — senão nada é gravado.
 */
function textoComImagem(texto: string, imagem: string): string {
  const posicao = localizarImagem(parseDocument(texto));
  if (posicao === null) throw new PublicacaoError(MENSAGEM_NAO_SIMPLES);
  let novo: string;
  if (posicao.tipo === 'valor') {
    const { inicio, fim } = posicao;
    const antes = texto[inicio - 1] === ':' ? ' ' : '';
    // `image: # comentário` tem valor vazio colado no `#`: sem o espaço, o comentário viraria valor.
    const depois = texto[fim] === '#' ? ' ' : '';
    novo = `${texto.slice(0, inicio)}${antes}${imagem}${depois}${texto.slice(fim)}`;
  } else {
    const base = texto.length === 0 || texto.endsWith('\n') ? texto : `${texto}\n`;
    novo = `${base}image: ${imagem}\n`;
  }
  const relido = parseDocument(novo);
  if (relido.errors.length > 0 || (relido.toJS() as { image?: unknown })?.image !== imagem) {
    throw new PublicacaoError(
      'Não consegui gravar o image: no manifest.yaml sem alterar o resto — corrija à mão.',
    );
  }
  return novo;
}

/**
 * Relê o arquivo NA HORA (o autor pode ter editado durante o build) e grava
 * por temporário + rename: falha no meio não deixa manifesto pela metade.
 */
function gravarManifesto(caminho: string, imagem: string): void {
  const novo = textoComImagem(readFileSync(caminho, 'utf8'), imagem);
  const temporario = join(dirname(caminho), `.manifest.yaml.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temporario, novo, { mode: statSync(caminho).mode & 0o777 });
    renameSync(temporario, caminho);
  } catch (e) {
    rmSync(temporario, { force: true });
    throw new PublicacaoError(
      `Não consegui gravar o manifest.yaml (${(e as NodeJS.ErrnoException).code ?? 'erro'}): ` +
        'copie a imagem acima para o image: à mão.',
    );
  }
}

/**
 * A retenção do registry só protege a ÚLTIMA tag do repositório: sem tag, a
 * imagem publicada por digest seria coletada. `image:` continua por digest.
 */
function tagDeRetencao(agora: Date): string {
  return `adk-${agora.toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
}

function cauda(saida: string): string {
  return saida.split('\n').slice(-LINHAS_DE_ERRO).join('\n');
}

interface Construcao {
  raiz: string;
  tag: string;
  tar: string;
  plataforma: string;
}

async function construirESalvar(
  ctx: Ctx,
  { raiz, tag, tar, plataforma }: Construcao,
): Promise<void> {
  const opcoes = {
    cwd: raiz,
    variaveisExtras: VARIAVEIS_DOCKER,
    maxBufferBytes: BUFFER_DOCKER_BYTES,
  };
  const build = await executar(
    ctx,
    'docker',
    ['build', '--platform', plataforma, '-t', tag, raiz],
    {
      ...opcoes,
      timeoutMs: TIMEOUT_BUILD_MS,
    },
  );
  if (!build.ok) throw new PublicacaoError(`docker build falhou:\n${cauda(build.saida)}`);
  // Sem --platform: no save a flag só existe a partir do Docker 28 (quebraria o 25–27), e a tag já aponta só o build acima.
  const save = await executar(ctx, 'docker', ['save', '-o', tar, tag], {
    ...opcoes,
    timeoutMs: TIMEOUT_SAVE_MS,
  });
  if (!save.ok) throw new PublicacaoError(`docker save falhou:\n${cauda(save.saida)}`);
}

export async function comandoPublish(
  ctx: Ctx,
  opcoes: { dir?: string; registry?: string; platform?: string },
): Promise<number> {
  const raiz = resolve(ctx.cwd, opcoes.dir ?? '.');
  const caminhoManifesto = join(raiz, 'manifest.yaml');
  let temporario: string | undefined;
  try {
    const registry = resolverRegistry(ctx, opcoes.registry);
    const manifesto = lerManifesto(caminhoManifesto);
    const repositorio = `${NAMESPACE}/${manifesto.slug}`;

    const cliente = new ClienteRegistry({
      base: registry.origin,
      repositorio,
      hubUrl: hubUrl(ctx),
      credencialAdk: () => accessToken(ctx),
    });
    await cliente.autorizar();

    const plataforma = opcoes.platform ?? PLATAFORMA_PADRAO;
    ctx.out(`Construindo ${manifesto.slug} para ${plataforma} (docker build em ${raiz})…`);
    temporario = mkdtempSync(join(tmpdir(), 'adk-publish-'));
    const tar = join(temporario, 'imagem.tar');
    await construirESalvar(ctx, { raiz, tag: `${repositorio}:adk-publish`, tar, plataforma });

    ctx.out(`Enviando para ${registry.host}/${repositorio}…`);
    const layout = LayoutOci.abrir(tar);
    let digest: string;
    try {
      const topo = layout.topo();
      layout.verificar(topo);
      await cliente.enviarManifesto(layout, topo);
      await cliente.etiquetar(layout, topo, tagDeRetencao(new Date()));
      digest = topo.digest;
    } finally {
      layout.fechar();
    }

    const imagem = `${registry.host}/${repositorio}@${digest}`;
    // Antes de gravar: se a gravação falhar, o autor já tem o digest para colar à mão.
    ctx.out(`Publicado: ${imagem}`);
    gravarManifesto(caminhoManifesto, imagem);
    ctx.out(
      'manifest.yaml atualizado com o digest — o próximo `adk plan`/`deploy` usa esta imagem.',
    );
    return 0;
  } catch (e) {
    if (e instanceof PreCondicaoError) {
      ctx.err(e.message);
      return 2;
    }
    if (e instanceof PublicacaoError || e instanceof LayoutInvalidoError) {
      ctx.err(e.message);
      return 1;
    }
    ctx.err(`Falha ao publicar: ${(e as Error).message}`);
    return 1;
  } finally {
    if (temporario) rmSync(temporario, { recursive: true, force: true });
  }
}

/**
 * Leitura do layout OCI que o `docker save` (Docker >= 25) grava num tar.
 *
 * O tar é indexado sem extrair: cada blob é lido do próprio arquivo, pelo
 * deslocamento, só na hora de subir — a memória fica no tamanho do maior blob,
 * não da imagem inteira, e nada do conteúdo da imagem cai no disco do autor.
 */

import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/** Descritor OCI (entrada de `index.json`, `manifests[]`, `config` e `layers[]`). */
export interface Descritor {
  mediaType?: string;
  digest: string;
  size?: number;
}

/** O que importa de um manifesto: os filhos (índice) ou os blobs (imagem). */
export interface DocumentoManifesto {
  mediaType?: string;
  manifests?: Descritor[];
  config?: Descritor;
  layers?: Descritor[];
}

export class LayoutInvalidoError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'LayoutInvalidoError';
  }
}

const BLOCO = 512;
const DIGEST_SHA256 = /^sha256:[0-9a-f]{64}$/;
const PEDACO = 4 * 1024 * 1024;

interface EntradaTar {
  inicio: number;
  tamanho: number;
}

function textoC(buf: Buffer, inicio: number, fim: number): string {
  const trecho = buf.subarray(inicio, fim);
  const nulo = trecho.indexOf(0);
  return trecho.subarray(0, nulo === -1 ? trecho.length : nulo).toString('utf8');
}

/** Tamanho do cabeçalho ustar: octal, ou base-256 (bit alto) para arquivo acima de 8 GiB. */
function tamanhoDoCabecalho(cabecalho: Buffer): number {
  const campo = cabecalho.subarray(124, 136);
  if (campo[0] & 0x80) {
    let valor = 0;
    for (let i = 1; i < campo.length; i++) valor = valor * 256 + campo[i];
    return valor;
  }
  return parseInt(textoC(campo, 0, campo.length).trim() || '0', 8);
}

/** Registros `"<len> chave=valor\n"` de um cabeçalho PAX. */
function caminhoDoPax(dados: Buffer): string | undefined {
  let resto = dados.toString('utf8');
  while (resto.length > 0) {
    const espaco = resto.indexOf(' ');
    const tamanho = Number(resto.slice(0, espaco));
    if (espaco === -1 || !Number.isInteger(tamanho) || tamanho <= 0) return undefined;
    const registro = resto.slice(espaco + 1, tamanho).replace(/\n$/, '');
    const igual = registro.indexOf('=');
    if (registro.slice(0, igual) === 'path') return registro.slice(igual + 1);
    resto = resto.slice(tamanho);
  }
  return undefined;
}

function normalizarCaminho(caminho: string): string {
  return caminho.replace(/^\.\//, '');
}

export class LayoutOci {
  private readonly fd: number;
  private readonly entradas = new Map<string, EntradaTar>();

  private constructor(caminhoTar: string) {
    this.fd = openSync(caminhoTar, 'r');
    try {
      this.indexar();
    } catch (e) {
      closeSync(this.fd);
      throw e;
    }
  }

  static abrir(caminhoTar: string): LayoutOci {
    return new LayoutOci(caminhoTar);
  }

  fechar(): void {
    closeSync(this.fd);
  }

  private lerTrecho(inicio: number, tamanho: number): Buffer {
    const buf = Buffer.alloc(tamanho);
    let lidos = 0;
    while (lidos < tamanho) {
      const n = readSync(this.fd, buf, lidos, tamanho - lidos, inicio + lidos);
      if (n === 0)
        throw new LayoutInvalidoError('o tar do docker save terminou no meio de um arquivo');
      lidos += n;
    }
    return buf;
  }

  private indexar(): void {
    const total = fstatSync(this.fd).size;
    let posicao = 0;
    let proximoCaminho: string | undefined;
    while (posicao + BLOCO <= total) {
      const cabecalho = this.lerTrecho(posicao, BLOCO);
      if (cabecalho.every((b) => b === 0)) break;
      const tamanho = tamanhoDoCabecalho(cabecalho);
      const tipo = String.fromCharCode(cabecalho[156] || 0x30);
      const inicio = posicao + BLOCO;
      // Tamanho declarado é dado do arquivo: conferido antes de qualquer leitura ou alocação.
      if (!Number.isSafeInteger(tamanho) || tamanho < 0 || inicio + tamanho > total) {
        throw new LayoutInvalidoError(
          'o tar do docker save está corrompido: um cabeçalho declara mais bytes do que o arquivo tem',
        );
      }
      posicao = inicio + Math.ceil(tamanho / BLOCO) * BLOCO;

      if (tipo === 'x') {
        proximoCaminho = caminhoDoPax(this.lerTrecho(inicio, tamanho)) ?? proximoCaminho;
        continue;
      }
      if (tipo === 'L') {
        proximoCaminho = textoC(this.lerTrecho(inicio, tamanho), 0, tamanho);
        continue;
      }
      const ustar = textoC(cabecalho, 257, 262) === 'ustar';
      const prefixo = ustar ? textoC(cabecalho, 345, 500) : '';
      const nome = textoC(cabecalho, 0, 100);
      const caminho = proximoCaminho ?? (prefixo ? `${prefixo}/${nome}` : nome);
      proximoCaminho = undefined;
      if (tipo === '0' || tipo === '7') {
        this.entradas.set(normalizarCaminho(caminho), { inicio, tamanho });
      }
    }
  }

  private arquivo(caminho: string): Buffer | undefined {
    const entrada = this.entradas.get(caminho);
    return entrada ? this.lerTrecho(entrada.inicio, entrada.tamanho) : undefined;
  }

  /** O manifesto que o `index.json` aponta — a imagem salva, e o digest que se publica. */
  topo(): Descritor {
    const bruto = this.arquivo('index.json');
    if (!bruto) throw new LayoutInvalidoError('o docker save não gerou index.json (layout OCI)');
    const indice = JSON.parse(bruto.toString('utf8')) as DocumentoManifesto;
    const manifestos = indice.manifests ?? [];
    if (manifestos.length !== 1 || !DIGEST_SHA256.test(manifestos[0].digest)) {
      throw new LayoutInvalidoError(
        `o index.json do docker save devia apontar uma imagem só (aponta ${manifestos.length})`,
      );
    }
    return manifestos[0];
  }

  private entradaDoBlob(digest: string): EntradaTar {
    if (!DIGEST_SHA256.test(digest)) {
      throw new LayoutInvalidoError(`digest fora do formato sha256: ${digest}`);
    }
    const entrada = this.entradas.get(`blobs/sha256/${digest.slice('sha256:'.length)}`);
    if (!entrada) throw new LayoutInvalidoError(`o docker save não incluiu o blob ${digest}`);
    return entrada;
  }

  /** sha256 lido em pedaços: conferir uma camada grande não a carrega inteira. */
  private conferir(digest: string): void {
    const { inicio, tamanho } = this.entradaDoBlob(digest);
    const hash = createHash('sha256');
    for (let lido = 0; lido < tamanho; lido += PEDACO) {
      hash.update(this.lerTrecho(inicio + lido, Math.min(PEDACO, tamanho - lido)));
    }
    if (`sha256:${hash.digest('hex')}` !== digest) {
      throw new LayoutInvalidoError(`o blob ${digest} do docker save não confere com o digest`);
    }
  }

  /**
   * Confere o sha256 de TUDO o que o manifesto alcança antes do primeiro push:
   * um blob adulterado reprova a publicação inteira, e nada sobe pela metade.
   */
  verificar(descritor: Descritor, vistos = new Set<string>()): void {
    if (vistos.has(descritor.digest)) return;
    vistos.add(descritor.digest);
    this.conferir(descritor.digest);
    const documento = JSON.parse(
      this.blob(descritor.digest).toString('utf8'),
    ) as DocumentoManifesto;
    for (const filho of documento.manifests ?? []) this.verificar(filho, vistos);
    for (const blob of [documento.config, ...(documento.layers ?? [])]) {
      if (blob && !vistos.has(blob.digest)) {
        vistos.add(blob.digest);
        this.conferir(blob.digest);
      }
    }
  }

  /** Bytes do blob, conferidos contra o digest: é o que garante o digest impresso. */
  blob(digest: string): Buffer {
    const { inicio, tamanho } = this.entradaDoBlob(digest);
    const bytes = this.lerTrecho(inicio, tamanho);
    const calculado = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (calculado !== digest) {
      throw new LayoutInvalidoError(`o blob ${digest} do docker save não confere com o digest`);
    }
    return bytes;
  }
}

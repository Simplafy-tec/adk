/** Varredura do diretório do pacote — o que o `build` valida e mede. */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Nunca entram na varredura: são geradas, versionadas à parte ou segredo local. */
const IGNORADAS = new Set(['.git', '.venv', 'node_modules', 'dist', '__pycache__', '.mypy_cache']);

/** Extensões cujo conteúdo é texto de configuração/código — o que o scanner lê. */
const TEXTO = new Set([
  '.py',
  '.yaml',
  '.yml',
  '.json',
  '.toml',
  '.md',
  '.txt',
  '.cfg',
  '.ini',
  // `kind: app` é TypeScript/CSS/HTML. Sem estas, o `scanLeaks` e o lint de
  // aderência atravessariam o app inteiro sem ler uma linha — falso verde.
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.html',
]);

export interface ArquivoDoPacote {
  /** Caminho relativo à raiz do pacote (é o `path` das issues). */
  rel: string;
  abs: string;
  bytes: number;
  texto: boolean;
}

export function listarArquivos(raiz: string): ArquivoDoPacote[] {
  const encontrados: ArquivoDoPacote[] = [];
  const visitar = (dir: string): void => {
    let entradas: string[];
    try {
      entradas = readdirSync(dir);
    } catch {
      return;
    }
    for (const nome of entradas) {
      if (IGNORADAS.has(nome)) continue;
      // `.env*` fica de fora de propósito: é local, não versionado, e é o
      // lugar CERTO do segredo — escaneá-lo reprovaria o uso correto.
      if (nome.startsWith('.env')) continue;
      const abs = join(dir, nome);
      const st = statSync(abs);
      if (st.isDirectory()) {
        visitar(abs);
        continue;
      }
      const ext = nome.slice(nome.lastIndexOf('.'));
      encontrados.push({ rel: relative(raiz, abs), abs, bytes: st.size, texto: TEXTO.has(ext) });
    }
  };
  visitar(raiz);
  return encontrados;
}

export function lerTexto(arquivo: ArquivoDoPacote): string {
  return readFileSync(arquivo.abs, 'utf8');
}

/**
 * Leitura do `npm pack --dry-run --json` que sobrevive à versão do npm.
 *
 * A npm 11 devolve um ARRAY de relatórios (um por tarball); a 12 mudou o
 * formato e o `const [relatorio] = JSON.parse(saida)` passou a estourar
 * `TypeError: object is not iterable`. Quebrou 4 testes no job de publicação,
 * que instala `npm@latest` de propósito para autenticar por OIDC — ou seja, a
 * versão do npm ali NÃO é escolha nossa e vai continuar mudando.
 *
 * Por isso a leitura é tolerante ao formato, mas NÃO ao conteúdo: se nenhum
 * relatório com `files` aparecer, lança — um teste de vazamento que degrada
 * para "lista vazia" passaria a aprovar qualquer tarball, que é exatamente o
 * contrário do que ele existe para fazer.
 */
export interface RelatorioPack {
  files: { path: string }[];
}

export function relatorioDoPack(saida: string): RelatorioPack {
  const cru: unknown = JSON.parse(saida);

  const temFiles = (v: unknown): v is RelatorioPack =>
    typeof v === 'object' && v !== null && Array.isArray((v as RelatorioPack).files);

  if (Array.isArray(cru)) {
    const achado = cru.find(temFiles);
    if (achado) return achado;
  }
  if (temFiles(cru)) return cru;
  if (typeof cru === 'object' && cru !== null) {
    const achado = Object.values(cru as Record<string, unknown>).find(temFiles);
    if (achado) return achado;
  }
  throw new Error(
    `npm pack --json não trouxe nenhum relatório com "files" (npm mudou o formato?): ${saida.slice(0, 200)}`,
  );
}

export function arquivosDoPack(saida: string): string[] {
  return relatorioDoPack(saida).files.map((f) => f.path);
}

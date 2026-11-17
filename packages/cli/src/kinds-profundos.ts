/**
 * Os kinds cujo portão é do SERVIDOR (issue#2768, issue#2769).
 *
 * `mcp`, `app` e `table` não são julgados pelo `@simpla.fy/adk-contract`:
 * a decisão está documentada em `packages/contract/src/spec-gates.ts` —
 * replicar o portão profundo no pacote público criaria duas fontes de verdade.
 *
 * O efeito colateral medido é que o autor recebia ✓ de um gate que sabe que
 * não julgou o artefato, e um `get_contract` que respondia "kind desconhecido"
 * justamente para os três. Este mapa não é o portão: é o que a CLI SABE que o
 * apply vai exigir, para dizer em voz alta em vez de deixar o autor descobrir
 * por tentativa e erro contra o servidor.
 *
 * Fonte: `apps/api/src/adk/spec-gates.ts` do hub-v2 (`validateMcpSpecStructure`,
 * `validateAppSpecStructure`, `validateTableSpecStructure`).
 */

export interface CampoObrigatorio {
  campo: string;
  exigencia: string;
}

export interface KindProfundo {
  campos: readonly CampoObrigatorio[];
}

export const KINDS_PORTAO_PROFUNDO: Readonly<Record<string, KindProfundo>> = {
  mcp: {
    campos: [
      { campo: 'name', exigencia: 'nome de exibição do satélite, no TOPO do arquivo.' },
      {
        campo: 'image',
        exigencia:
          'imagem por digest: <host>/<namespace>/<repo>@sha256:<64 hex>. Tag é mutável e não é aceita. ' +
          'Registries permitidos: ghcr.io/simplafy-tec, registry.simplafy.com.br/simplafy-tec.',
      },
      {
        campo: 'url',
        exigencia: 'URL http(s) absoluta do satélite já em execução — host público, nunca interno.',
      },
    ],
  },
  app: {
    campos: [
      { campo: 'name', exigencia: 'nome de exibição do app, no TOPO do arquivo.' },
      { campo: 'icon', exigencia: 'ícone do app (a coluna do registro é obrigatória).' },
    ],
  },
  // `table` NÃO passa por `manifestoComumIssues` no servidor: não exige `name`
  // (medido em staging — tabela sem `name` aplica). Listar `name` aqui seria
  // inventar obrigatoriedade, que é o defeito que esta issue conserta.
  table: {
    campos: [
      { campo: 'app', exigencia: 'slug do app dono da tabela, em `app:`.' },
      { campo: 'columns', exigencia: 'ao menos uma coluna declarada.' },
    ],
  },
} as const;

/** A frase que acompanha qualquer resposta sobre estes kinds. */
export const NOTA_PORTAO_PROFUNDO =
  'O contrato público não julga este kind — quem julga é o apply do Hub. ' +
  'O `adk build` aprova a forma geral; os campos acima só são conferidos no servidor.';

export function temPortaoProfundo(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(KINDS_PORTAO_PROFUNDO, kind);
}

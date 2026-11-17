/**
 * ADK — resolução de referências simbólicas.
 *
 * Porte fiel de `apps/api/src/adk/reference-resolver.ts` (hub-v2,
 * origin/staging). O arquivo declarativo aponta para canal, pipeline e afins
 * por nome legível, não por cuid — é isso que o torna válido fora do ambiente
 * de origem.
 *
 * A resolução é fail-closed por construção: só casamento ÚNICO resolve. Zero
 * candidatos e dois candidatos produzem o mesmo desfecho — pendência —, porque
 * adotar "o primeiro" ligaria o agente ao canal errado em silêncio.
 */

export type PendingReason = 'not_found' | 'ambiguous';

export interface ResolvedReference {
  status: 'resolved';
  id: string;
}

export interface PendingReference {
  status: 'pending';
  reason: PendingReason;
  /** Slug procurado — o que a UI mostra para quem vai resolver a pendência. */
  slug: string;
  /** Quantos candidatos casaram; 0 em not_found, >1 em ambiguous. */
  candidates: number;
}

export type ReferenceResolution = ResolvedReference | PendingReference;

export interface NamedResource {
  id: string;
  name: string;
}

/**
 * Forma legível e estável de um nome de recurso.
 *
 * Sem acento, minúsculo, separado por hífen — para que "Funil de Produtores" e
 * "funil-de-produtores" sejam o mesmo endereço, e o arquivo continue legível
 * por quem revisa.
 */
export function toSlug(name: string): string {
  return (
    name
      .normalize('NFD')
      // Escape explícito em vez do intervalo literal: caractere combining é
      // invisível no editor e some numa cópia distraída.
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  );
}

/** Slug de um recurso, para o lado do export. */
export function referenceSlugOf(resource: NamedResource | null | undefined): string | null {
  if (!resource?.name) return null;
  const slug = toSlug(resource.name);
  return slug.length > 0 ? slug : null;
}

/**
 * Resolve um slug contra os recursos da organização de destino.
 *
 * `resources` já vem escopado por organização por quem chama — esta unidade não
 * conhece tenancy, e é justamente por isso que ela não pode ser o lugar onde o
 * escopo se perde.
 */
export function resolveReference(
  slug: string,
  resources: readonly NamedResource[],
): ReferenceResolution {
  const alvo = toSlug(slug);
  const casados = resources.filter((r) => toSlug(r.name) === alvo);

  if (casados.length === 1) {
    return { status: 'resolved', id: casados[0].id };
  }

  return {
    status: 'pending',
    reason: casados.length === 0 ? 'not_found' : 'ambiguous',
    slug: alvo,
    candidates: casados.length,
  };
}

export function isPending(resolution: ReferenceResolution): resolution is PendingReference {
  return resolution.status === 'pending';
}

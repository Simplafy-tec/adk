/**
 * ADK — forma declarativa do time (kind: team).
 *
 * ADR-290 (D1–D5, F1). O time deixa de ter formato próprio no Hub (`times/catalogo/esquema.ts`) e passa a ser um pacote do
 * ADK: `team.yaml` na raiz. O esquema aqui é o MESMO do `esquema.ts` do Hub — mesmos nomes de campo, em português, na vitrine,
 * equipe e «Falta pouco» (texto de produto já aprovado) —, mais o cabeçalho do contrato (`spec_version`, `kind`) e a forma
 * da peça (D3): cada peça é `call:` (chamada ao MCP completo, a de hoje) OU `spec:` (arquivo declarativo do pacote).
 *
 * Funções PURAS. O que só o servidor sabe (a função `call.ferramenta` existe no catálogo do MCP completo; o `release` do
 * `spec:`) NÃO é julgado aqui. O que o pacote não carrega: segredo, escolha de modelo (só o perfil), canal, plano/limite de
 * plano e `requisitos` (calculado pelo Hub a cada carregamento).
 */

import { z } from 'zod';
import { SUPPORTED_SPEC_VERSIONS, type SpecIssue, type SpecIssueCode } from './spec-gates.js';

export const TEAM_IDIOMAS = ['pt', 'en', 'es'] as const;
export type TeamIdioma = (typeof TEAM_IDIOMAS)[number];

export const TEAM_AREAS = [
  'comercial',
  'atendimento',
  'operacoes',
  'pos-venda',
  'rh',
  'gestao',
  'marketing',
  'financeiro',
] as const;
export type TeamArea = (typeof TEAM_AREAS)[number];

export const TEAM_TAMANHOS = ['pequeno', 'grande'] as const;
export type TeamTamanho = (typeof TEAM_TAMANHOS)[number];

export const TEAM_GRUPOS_DE_PECA = [
  'agentes',
  'crm',
  'jornadas',
  'dashboard',
  'tools-apps',
] as const;
export type TeamGrupoDePeca = (typeof TEAM_GRUPOS_DE_PECA)[number];

/** Perfil de modelo (não o modelo): o seletor único do Hub decide qual modelo atende cada perfil. */
export const TEAM_PERFIS_DE_MODELO = ['recomendado', 'rapido', 'barato'] as const;

/** Condição de «feito» de um item do «Falta pouco». */
export const TEAM_TIPOS_DE_CONDICAO = [
  'canal-conectado',
  'agente-ativo',
  'jornada-ativa',
  'confirmacao-manual',
  // TC2 (Hub#2.6.27.48): cinco condições novas, todas sobre algo que a organização já tem no Hub.
  'responsavel-definido',
  'integracao-conectada',
  'catalogo-com-item',
  'acompanhamento-ativo',
  'email-do-agente-ligado',
] as const;

/** Tipos declarativos do ADK que uma peça `spec:` pode apontar (ADR-290 D3-a). */
export const TEAM_SPEC_PIECE_KINDS = ['agent', 'journey', 'tool', 'table', 'app'] as const;

/** Função do MCP completo que cria um agente: a peça com ela precisa de um membro de mesma chave na equipe. */
export const FERRAMENTA_CRIA_AGENTE = 'agents-crt';

/** Tetos de vitrine (ADR-281 D33), por idioma. */
export const TEAM_LIMITE_FRASE = 110;
export const TEAM_LIMITE_PASSO = 90;
export const TEAM_LIMITE_ROTULO = 80;

const texto = z.string().trim().min(1, 'texto vazio');

/** Texto de vitrine: pt, en e es, os três obrigatórios. */
export const TeamTexto3 = z.object({ pt: texto, en: texto, es: texto }).strict();
export type TeamTexto3 = z.infer<typeof TeamTexto3>;

const texto3Ate = (max: number) =>
  TeamTexto3.superRefine((t, ctx) => {
    for (const l of TEAM_IDIOMAS) {
      if (t[l].length > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [l],
          message: `no máximo ${max} caracteres (tem ${t[l].length})`,
        });
      }
    }
  });

const chave = z
  .string()
  .regex(
    /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/,
    'use minúsculas, números e hífen (ex.: agente-comercial)',
  );

const obrigatorio = { required_error: 'campo obrigatório' };

export const TeamVitrine = z
  .object({
    nome: TeamTexto3,
    /** Frase do cartão, até 110 caracteres por idioma. */
    frase: texto3Ate(TEAM_LIMITE_FRASE),
    /** OPCIONAL: só existe depois de medido numa montagem real. */
    tempoDeMontagem: z
      .object({ prontoEmMin: z.number().int().min(1), voceTerminaEmMin: z.number().int().min(1) })
      .strict()
      .optional(),
    /** «Na prática»: 3 ou 4 passos, até 90 caracteres cada, por idioma. */
    naPratica: z
      .array(texto3Ate(TEAM_LIMITE_PASSO))
      .min(3, 'de 3 a 4 passos')
      .max(4, 'de 3 a 4 passos'),
    canaisSugeridos: TeamTexto3,
    depoisSoVoceFaz: TeamTexto3,
    /** Id do asset da cena (arte do time na vitrine). */
    cena: chave,
  })
  .strict();
export type TeamVitrine = z.infer<typeof TeamVitrine>;

export const TeamMembro = z
  .object({
    /** Igual à `chave` da peça de agente que cria este membro (quando o time tem peças). */
    chave,
    papel: z.enum(['principal', 'sub-agente']),
    nome: TeamTexto3,
    papelTitulo: TeamTexto3,
    oQueFaz: TeamTexto3,
    perfilDeModelo: z.enum(TEAM_PERFIS_DE_MODELO, {
      errorMap: () => ({ message: `deve ser um de: ${TEAM_PERFIS_DE_MODELO.join(', ')}` }),
    }),
  })
  .strict();
export type TeamMembro = z.infer<typeof TeamMembro>;

/** Forma (b) da peça (D3): a chamada ao MCP completo de hoje, sem mudança. */
export const TeamPecaCall = z
  .object({
    /** Nome de uma função do MCP completo (ex.: `agents-crt`). Só o servidor confere que ela existe. */
    ferramenta: z.string().min(1, 'campo obrigatório'),
    /** Argumentos da função; `${peca:<chave>.id}` aponta para o id criado por uma peça ANTERIOR. */
    argumentos: z.record(z.unknown()),
    /** Função do MCP completo que remove ou arquiva o que a peça criou; `null` = o assistente não desfaz (veja `semDesfazer`). */
    desfazer: z.string().min(1).nullable(),
    /** Argumentos da função de desfazer, quando ela é a mesma de montar. */
    desfazerArgumentos: z.record(z.unknown()).optional(),
    /** Obrigatório quando `desfazer` é `null`: por que a montagem não desfaz esta peça. */
    semDesfazer: TeamTexto3.optional(),
  })
  .strict();
export type TeamPecaCall = z.infer<typeof TeamPecaCall>;

/** Forma (a) da peça (D3): aponta para um arquivo do pacote num tipo declarativo do ADK. */
export const TeamPecaSpec = z
  .object({
    kind: z.enum(TEAM_SPEC_PIECE_KINDS, {
      errorMap: () => ({ message: `deve ser um de: ${TEAM_SPEC_PIECE_KINDS.join(', ')}` }),
    }),
    /** Caminho relativo à raiz do pacote (ex.: `agentes/ana.yaml`). */
    arquivo: z.string().min(1, 'campo obrigatório'),
  })
  .strict();
export type TeamPecaSpec = z.infer<typeof TeamPecaSpec>;

export const TeamPeca = z
  .object({
    chave,
    /** Texto da peça em «O que é montado» (até 80 caracteres por idioma). */
    rotulo: texto3Ate(TEAM_LIMITE_ROTULO),
    grupo: z.enum(TEAM_GRUPOS_DE_PECA, {
      errorMap: () => ({ message: `deve ser um de: ${TEAM_GRUPOS_DE_PECA.join(', ')}` }),
    }),
    /** UMA das duas formas (D3): `call` ou `spec`. */
    call: TeamPecaCall.optional(),
    spec: TeamPecaSpec.optional(),
    /**
     * Jornada ou acompanhamento de etapa (grupo `crm`): fica ATIVA ao ligar o time (conta no limite de automações do
     * plano). `false` cria a peça DESLIGADA; o desfazer é o de sempre.
     */
    ativaAoLigar: z.boolean().optional(),
    /**
     * Peça que ATUALIZA o que uma peça anterior criou (ex.: grava o id do funil no agente). Chave da peça-mãe, que tem
     * de vir antes. O que ela muda desfaz junto com a peça-mãe: por isso `desfazer: null` dispensa `semDesfazer`.
     */
    atualiza: chave.optional(),
    /** A peça depende de algo ainda «Em breve»: time `liberado: true` não pode ter uma. */
    emBreve: z.boolean().optional(),
  })
  .strict();
export type TeamPeca = z.infer<typeof TeamPeca>;

export const TeamCondicaoDeFeito = z
  .object({
    tipo: z.enum(TEAM_TIPOS_DE_CONDICAO, {
      errorMap: () => ({ message: `deve ser um de: ${TEAM_TIPOS_DE_CONDICAO.join(', ')}` }),
    }),
    /** `canal-conectado`: tipo do canal (ex.: `whatsapp-oficial`). */
    canal: z.string().min(1).optional(),
    /** `canal-conectado`: feito quando QUALQUER um destes tipos de canal está conectado (alternativa a `canal`). */
    canais: z.array(z.string().min(1)).min(1).optional(),
    /** `integracao-conectada`: chave da integração (ex.: `google-agenda`). */
    integracao: chave.optional(),
    /** `agente-ativo` / `jornada-ativa` / `acompanhamento-ativo` / `email-do-agente-ligado`: chave da peça. */
    peca: chave.optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.tipo === 'canal-conectado' && !c.canal && !c.canais) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['canal'],
        message: 'obrigatório em "canal-conectado": "canal" ou "canais"',
      });
    }
    if (c.tipo === 'canal-conectado' && c.canal && c.canais) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['canais'],
        message: 'use "canal" ou "canais" em "canal-conectado", não os dois',
      });
    }
    if (c.tipo !== 'canal-conectado' && (c.canal || c.canais)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [c.canal ? 'canal' : 'canais'],
        message: 'só vale em "canal-conectado"',
      });
    }
    if (c.tipo === 'integracao-conectada' && !c.integracao) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['integracao'],
        message: 'obrigatório em "integracao-conectada"',
      });
    }
    if (c.tipo !== 'integracao-conectada' && c.integracao) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['integracao'],
        message: 'só vale em "integracao-conectada"',
      });
    }
    if (
      (c.tipo === 'agente-ativo' ||
        c.tipo === 'jornada-ativa' ||
        c.tipo === 'acompanhamento-ativo' ||
        c.tipo === 'email-do-agente-ligado') &&
      !c.peca
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['peca'],
        message: `obrigatório em "${c.tipo}"`,
      });
    }
  });
export type TeamCondicaoDeFeito = z.infer<typeof TeamCondicaoDeFeito>;

export const TeamItemFaltaPouco = z
  .object({
    chave,
    obrigatorio: z.boolean(obrigatorio),
    texto: TeamTexto3,
    /** Lugar da tela onde a pessoa resolve (id lógico da tela, não rota). */
    destino: chave,
    feito: TeamCondicaoDeFeito,
    /** Fazer este item gasta 1 automação do plano: a tela avisa «usa 1 das suas automações». */
    gastaAutomacao: z.boolean().optional(),
  })
  .strict();
export type TeamItemFaltaPouco = z.infer<typeof TeamItemFaltaPouco>;

const tamanho = z.enum(TEAM_TAMANHOS, {
  errorMap: () => ({ message: 'obrigatório: "pequeno" ou "grande"' }),
});
const area = z.enum(TEAM_AREAS, {
  errorMap: () => ({ message: `deve ser uma de: ${TEAM_AREAS.join(', ')}` }),
});

const comum = {
  spec_version: z.string(obrigatorio),
  kind: z.literal('team', { errorMap: () => ({ message: 'deve ser "team"' }) }),
  slug: chave,
  area,
  versao: z.number().int().min(1, 'deve ser inteiro a partir de 1'),
  liberado: z.boolean(obrigatorio),
  avisoParceiro: z.boolean(obrigatorio),
  tamanho,
  vitrine: TeamVitrine,
};

export const TeamAmploSpecSchema = z
  .object({
    ...comum,
    tipo: z.literal('amplo'),
    equipe: z.array(TeamMembro),
    pecas: z.array(TeamPeca),
    faltaPouco: z.array(TeamItemFaltaPouco),
  })
  .strict();
export type TeamAmploSpec = z.infer<typeof TeamAmploSpecSchema>;

/** O que o especialista SOMA ao amplo. Nunca remove nada. */
export const TeamDoSegmento = z
  .object({
    /** A equipe INTEIRA do especialista (1 a 6 membros, na ordem da tela); não é herdada do amplo (ADR-281 D34). */
    equipe: z
      .array(TeamMembro)
      .min(1, 'o especialista declara a equipe inteira (1 a 6)')
      .max(6, 'no máximo 6 membros'),
    pecas: z.array(TeamPeca).optional(),
    faltaPouco: z.array(TeamItemFaltaPouco).optional(),
    /** Trecho acrescentado ao `systemPrompt` de uma peça de agente (`call`) do amplo: `{ <chave da peça>: texto }`. */
    promptAcrescimo: z.record(chave, texto).optional(),
    /** Peças e itens do «Falta pouco» do amplo que o especialista NÃO herda (ADR-281 D39–D41). */
    naoHerda: z.array(chave).optional(),
  })
  .strict();
export type TeamDoSegmento = z.infer<typeof TeamDoSegmento>;

export const TeamEspecialistaSpecSchema = z
  .object({
    ...comum,
    tipo: z.literal('especialista'),
    /** Id do segmento (ex.: `imobiliaria-venda-locacao`). */
    segmento: chave,
    /** Rótulo do segmento no plural, para a vitrine («Imobiliárias»). */
    segmentoRotulo: TeamTexto3,
    /** Slug do time amplo de que este herda. */
    herda: chave,
    doSegmento: TeamDoSegmento,
  })
  .strict();
export type TeamEspecialistaSpec = z.infer<typeof TeamEspecialistaSpecSchema>;

export const TeamSpecSchema = z.discriminatedUnion(
  'tipo',
  [TeamAmploSpecSchema, TeamEspecialistaSpecSchema],
  {
    errorMap: (issue, ctx) =>
      issue.code === 'invalid_union_discriminator'
        ? { message: 'deve ser "amplo" ou "especialista"' }
        : { message: ctx.defaultError },
  },
);
export type TeamSpec = TeamAmploSpec | TeamEspecialistaSpec;

// --- Portão 1 do time -------------------------------------------------------

function formatarPath(path: ReadonlyArray<string | number>): string {
  return path.reduce<string>(
    (acc, p) => (typeof p === 'number' ? `${acc}[${p}]` : acc === '' ? p : `${acc}.${p}`),
    '',
  );
}

function descreverZod(i: z.ZodIssue): string {
  if (i.code === 'unrecognized_keys') return `campo não reconhecido (${i.keys.join(', ')})`;
  if (i.code === 'invalid_type' && i.received === 'undefined') return 'campo obrigatório';
  if (i.message === 'Required') return 'campo obrigatório';
  return i.message;
}

const REFERENCIA_DE_PECA = /\$\{peca:([a-z][a-z0-9-]*)\.id\}/g;

function referenciasDe(valor: unknown, achadas: string[] = []): string[] {
  if (typeof valor === 'string') {
    for (const m of valor.matchAll(REFERENCIA_DE_PECA)) achadas.push(m[1]);
  } else if (Array.isArray(valor)) {
    for (const v of valor) referenciasDe(v, achadas);
  } else if (valor !== null && typeof valor === 'object') {
    for (const v of Object.values(valor)) referenciasDe(v, achadas);
  }
  return achadas;
}

function referenciasDaPeca(p: TeamPeca): { montar: string[]; desfazer: string[] } {
  return {
    montar: referenciasDe(p.call?.argumentos ?? {}),
    desfazer: referenciasDe(p.call?.desfazerArgumentos ?? {}),
  };
}

/** A peça cria um agente: `call` com `agents-crt` ou `spec` do tipo agent. */
export function pecaCriaAgente(p: Pick<TeamPeca, 'call' | 'spec'>): boolean {
  return p.call?.ferramenta === FERRAMENTA_CRIA_AGENTE || p.spec?.kind === 'agent';
}

function duplicadas(
  lista: ReadonlyArray<{ chave: string }>,
  base: string,
  rotulo: string,
): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const vistas = new Set<string>();
  lista.forEach((item, i) => {
    if (vistas.has(item.chave)) {
      issues.push({
        code: 'duplicate_team_key',
        path: `${base}[${i}].chave`,
        message: `${rotulo}: chave "${item.chave}" repetida.`,
      });
    }
    vistas.add(item.chave);
  });
  return issues;
}

/** Regras comuns a uma lista de peças (D4), sobre a lista JÁ juntada na ordem de montagem. */
function regrasDasPecas(pecas: readonly TeamPeca[], base: string, liberado: boolean): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const anteriores = new Set<string>();
  const todas = new Set(pecas.map((p) => p.chave));
  pecas.forEach((p, i) => {
    const path = `${base}[${i}]`;
    if (!p.call && !p.spec) {
      issues.push({
        code: 'invalid_team_piece',
        path,
        message: `Peça "${p.chave}": declare "call" (chamada ao MCP completo) ou "spec" (arquivo do pacote).`,
      });
    } else if (p.call && p.spec) {
      issues.push({
        code: 'invalid_team_piece',
        path,
        message: `Peça "${p.chave}": declare só uma forma, "call" ou "spec", não as duas.`,
      });
    }
    if (p.atualiza !== undefined) {
      if (!p.call) {
        issues.push({
          code: 'invalid_team_piece',
          path: `${path}.atualiza`,
          message: `Peça "${p.chave}": "atualiza" só vale em peça com "call" (uma chamada que altera o que já existe).`,
        });
      }
      if (p.atualiza === p.chave || !anteriores.has(p.atualiza)) {
        issues.push({
          code: 'invalid_piece_reference',
          path: `${path}.atualiza`,
          message: `A peça "${p.atualiza}" não é uma peça anterior da lista: "atualiza" aponta para a peça-mãe, que vem antes.`,
        });
      }
    }
    if (p.call && p.call.desfazer === null && !p.call.semDesfazer && p.atualiza === undefined) {
      issues.push({
        code: 'undo_reason_missing',
        path: `${path}.call.semDesfazer`,
        message: `Peça "${p.chave}": obrigatório quando "desfazer" é null: diga por que a peça não se desfaz.`,
      });
    }
    if (p.ativaAoLigar !== undefined && p.grupo !== 'jornadas' && p.grupo !== 'crm') {
      issues.push({
        code: 'invalid_team_piece',
        path: `${path}.ativaAoLigar`,
        message: `Peça "${p.chave}": "ativaAoLigar" só vale em peça dos grupos "jornadas" e "crm" (acompanhamento de etapa).`,
      });
    }
    if (liberado && p.emBreve === true) {
      issues.push({
        code: 'released_team_with_em_breve',
        path: `${path}.emBreve`,
        message: `Peça "${p.chave}" está marcada «Em breve», mas o time está liberado.`,
      });
    }
    const refs = referenciasDaPeca(p);
    for (const ref of refs.montar) {
      if (!anteriores.has(ref)) {
        issues.push({
          code: 'invalid_piece_reference',
          path: `${path}.call.argumentos`,
          message: `A referência a "${ref}" não aponta para uma peça anterior da lista.`,
        });
      }
    }
    for (const ref of refs.desfazer) {
      if (!todas.has(ref)) {
        issues.push({
          code: 'invalid_piece_reference',
          path: `${path}.call.desfazerArgumentos`,
          message: `A referência a "${ref}" não aponta para uma peça deste time.`,
        });
      }
    }
    anteriores.add(p.chave);
  });
  return issues;
}

/**
 * Regras do time JÁ RESOLVIDO (amplo sozinho, ou amplo + segmento): é o que vale para a lista final de peças, na ordem
 * em que a montagem as cria.
 */
function regrasDoTimeResolvido(
  t: {
    liberado: boolean;
    equipe: readonly TeamMembro[];
    pecas: readonly TeamPeca[];
    faltaPouco: readonly TeamItemFaltaPouco[];
  },
  caminhos: { equipe: string; pecas: string; faltaPouco: string },
): SpecIssue[] {
  const issues: SpecIssue[] = [];
  issues.push(...duplicadas(t.equipe, caminhos.equipe, 'equipe'));
  issues.push(...duplicadas(t.pecas, caminhos.pecas, 'pecas'));
  issues.push(...duplicadas(t.faltaPouco, caminhos.faltaPouco, 'faltaPouco'));
  issues.push(...regrasDasPecas(t.pecas, caminhos.pecas, t.liberado));

  if (!t.equipe.some((e) => e.papel === 'principal')) {
    issues.push({
      code: 'team_without_principal',
      path: caminhos.equipe,
      message: 'A equipe deve ter pelo menos um membro com papel "principal".',
    });
  }
  if (t.pecas.length > 0) {
    const membros = new Set(t.equipe.map((e) => e.chave));
    t.pecas.forEach((p, i) => {
      if (pecaCriaAgente(p) && !membros.has(p.chave)) {
        issues.push({
          code: 'agent_piece_without_member',
          path: `${caminhos.pecas}[${i}].chave`,
          message: `A peça "${p.chave}" cria um agente que não está na equipe.`,
        });
      }
    });
  }
  const chavesDePeca = new Set(t.pecas.map((p) => p.chave));
  t.faltaPouco.forEach((item, i) => {
    if (item.feito.peca && !chavesDePeca.has(item.feito.peca)) {
      issues.push({
        code: 'unknown_team_piece',
        path: `${caminhos.faltaPouco}[${i}].feito.peca`,
        message: `A peça "${item.feito.peca}" não existe neste time.`,
      });
    }
  });
  return issues;
}

/**
 * Portão 1 do `kind: team`. Julga o arquivo sozinho: o amplo é julgado inteiro; o especialista, no que declara (a soma
 * com o amplo, e as regras que dependem dela, é de `resolverTime`).
 */
export function validateTeamSpecStructure(spec: unknown): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const versao = (spec as { spec_version?: unknown } | null)?.spec_version;
  if (typeof versao === 'string' && !SUPPORTED_SPEC_VERSIONS.includes(versao)) {
    issues.push({
      code: 'unknown_spec_version',
      path: 'spec_version',
      message: `Versão de especificação não reconhecida: ${versao}.`,
    });
  }
  const lido = TeamSpecSchema.safeParse(spec);
  if (!lido.success) {
    for (const i of lido.error.issues) {
      const path = formatarPath(i.path);
      const code: SpecIssueCode =
        path === 'slug'
          ? 'invalid_slug'
          : path === 'spec_version'
            ? 'unknown_spec_version'
            : 'invalid_field_value';
      issues.push({ code, path, message: descreverZod(i) });
    }
    return issues;
  }
  const t = lido.data;
  if (t.tipo === 'amplo') {
    issues.push(
      ...regrasDoTimeResolvido(t, { equipe: 'equipe', pecas: 'pecas', faltaPouco: 'faltaPouco' }),
    );
  } else {
    const d = t.doSegmento;
    issues.push(...duplicadas(d.equipe, 'doSegmento.equipe', 'doSegmento.equipe'));
    issues.push(...duplicadas(d.pecas ?? [], 'doSegmento.pecas', 'doSegmento.pecas'));
    issues.push(
      ...duplicadas(d.faltaPouco ?? [], 'doSegmento.faltaPouco', 'doSegmento.faltaPouco'),
    );
    issues.push(
      ...duplicadas(
        (d.naoHerda ?? []).map((c) => ({ chave: c })),
        'doSegmento.naoHerda',
        'doSegmento.naoHerda',
      ),
    );
    for (const [i, p] of (d.pecas ?? []).entries()) {
      if (!p.call && !p.spec) {
        issues.push({
          code: 'invalid_team_piece',
          path: `doSegmento.pecas[${i}]`,
          message: `Peça "${p.chave}": declare "call" (chamada ao MCP completo) ou "spec" (arquivo do pacote).`,
        });
      } else if (p.call && p.spec) {
        issues.push({
          code: 'invalid_team_piece',
          path: `doSegmento.pecas[${i}]`,
          message: `Peça "${p.chave}": declare só uma forma, "call" ou "spec", não as duas.`,
        });
      }
      // `atualiza` do segmento pode apontar para peça HERDADA do amplo: a existência e a ordem da peça-mãe se julgam no
      // time resolvido (`regrasDasPecas` sobre a lista final). Aqui só o que o arquivo sozinho já sabe.
      if (p.atualiza !== undefined && !p.call) {
        issues.push({
          code: 'invalid_team_piece',
          path: `doSegmento.pecas[${i}].atualiza`,
          message: `Peça "${p.chave}": "atualiza" só vale em peça com "call" (uma chamada que altera o que já existe).`,
        });
      }
      if (p.call && p.call.desfazer === null && !p.call.semDesfazer && p.atualiza === undefined) {
        issues.push({
          code: 'undo_reason_missing',
          path: `doSegmento.pecas[${i}].call.semDesfazer`,
          message: `Peça "${p.chave}": obrigatório quando "desfazer" é null: diga por que a peça não se desfaz.`,
        });
      }
      if (t.liberado && p.emBreve === true) {
        issues.push({
          code: 'released_team_with_em_breve',
          path: `doSegmento.pecas[${i}].emBreve`,
          message: `Peça "${p.chave}" está marcada «Em breve», mas o time está liberado.`,
        });
      }
    }
  }
  return issues;
}

// --- Herança (D5) -----------------------------------------------------------

export type TeamOrigem = 'amplo' | 'segmento';
export type TeamMembroResolvido = TeamMembro & { origem: TeamOrigem };
export type TeamPecaResolvida = TeamPeca & { origem: TeamOrigem };
export type TeamItemResolvido = TeamItemFaltaPouco & { origem: TeamOrigem };

/** O time final: o que o carregador do Hub entrega, sem `requisitos` (o Hub os calcula). */
export interface TimeResolvido {
  slug: string;
  tipo: 'amplo' | 'especialista';
  area: TeamArea;
  /** Só no especialista. */
  segmento: string | null;
  /** Só no especialista: slug do amplo. */
  herda: string | null;
  /** Só no especialista: rótulo do segmento no plural. */
  segmentoRotulo: TeamTexto3 | null;
  versao: number;
  liberado: boolean;
  avisoParceiro: boolean;
  tamanho: TeamTamanho;
  vitrine: TeamVitrine;
  equipe: TeamMembroResolvido[];
  /** Só no especialista: chaves do amplo que ele não herda (`doSegmento.naoHerda`). */
  naoHerda: string[];
  pecas: TeamPecaResolvida[];
  faltaPouco: TeamItemResolvido[];
}

export interface ResolucaoDoTime {
  /** `null` quando há erro. */
  time: TimeResolvido | null;
  issues: SpecIssue[];
}

class Falha extends Error {
  constructor(readonly issue: SpecIssue) {
    super(issue.message);
  }
}

function falha(code: SpecIssueCode, path: string, message: string): never {
  throw new Falha({ code, path, message });
}

function juntar<T extends { chave: string }>(
  rotulo: string,
  doAmplo: readonly T[],
  doSegmento: readonly T[],
  amploSlug: string | null,
): Array<T & { origem: TeamOrigem }> {
  const deAmplo = doAmplo.map((x) => ({ ...x, origem: 'amplo' as const }));
  const deSegmento = doSegmento.map((x) => ({ ...x, origem: 'segmento' as const }));
  const todos = [...deAmplo, ...deSegmento];
  const nosDoAmplo = new Set(doAmplo.map((x) => x.chave));
  const vistas = new Set<string>();
  for (const item of todos) {
    if (vistas.has(item.chave)) {
      const nota =
        amploSlug && nosDoAmplo.has(item.chave)
          ? ` (o amplo "${amploSlug}" já tem essa chave)`
          : '';
      falha('duplicate_team_key', rotulo, `${rotulo}: chave "${item.chave}" repetida${nota}.`);
    }
    vistas.add(item.chave);
  }
  return todos;
}

function resolver(amplo: TeamAmploSpec | null, m: TeamSpec): TimeResolvido {
  const segmento = m.tipo === 'especialista' ? m.doSegmento : null;
  const base: TeamAmploSpec = amplo ?? (m as TeamAmploSpec);
  const amploSlug = amplo?.slug ?? null;

  // Equipe: o amplo tem a sua; o ESPECIALISTA declara a equipe INTEIRA (ADR-281 D34). Mesma `chave` de um membro do amplo =
  // o mesmo agente, e exige o mesmo `papel`; chave nova é membro do segmento.
  const chavesDoAmplo = new Map((amplo?.equipe ?? []).map((e) => [e.chave, e]));
  let equipe: TeamMembroResolvido[];
  if (segmento) {
    const vistas = new Set<string>();
    for (const e of segmento.equipe) {
      if (vistas.has(e.chave))
        falha('duplicate_team_key', 'doSegmento.equipe', `equipe: chave "${e.chave}" repetida.`);
      vistas.add(e.chave);
    }
    equipe = segmento.equipe.map((e, i) => {
      const doAmplo = chavesDoAmplo.get(e.chave);
      if (doAmplo && doAmplo.papel !== e.papel) {
        falha(
          'invalid_team_inheritance',
          `doSegmento.equipe[${i}].papel`,
          `"${e.chave}" é o mesmo agente do amplo "${amploSlug}", mas o papel difere ("${e.papel}" ≠ "${doAmplo.papel}").`,
        );
      }
      return { ...e, origem: doAmplo ? ('amplo' as const) : ('segmento' as const) };
    });
  } else {
    equipe = juntar('equipe', base.equipe, [], null);
  }

  // `naoHerda` (D39–D41): peça ou item do «Falta pouco» do amplo que o especialista não herda.
  const naoHerda = new Set(segmento?.naoHerda ?? []);
  if (segmento) {
    const vistas = new Set<string>();
    for (const k of segmento.naoHerda ?? []) {
      if (vistas.has(k))
        falha(
          'duplicate_team_key',
          'doSegmento.naoHerda',
          `doSegmento.naoHerda: chave "${k}" repetida.`,
        );
      vistas.add(k);
    }
    const naEquipeDecl = new Set(equipe.map((e) => e.chave));
    for (const k of naoHerda) {
      const peca = base.pecas.find((p) => p.chave === k);
      const item = base.faltaPouco.find((i) => i.chave === k);
      if (!peca && !item) {
        falha(
          'invalid_team_inheritance',
          `doSegmento.naoHerda.${k}`,
          `o amplo "${amploSlug}" não tem peça nem item do «Falta pouco» com essa chave.`,
        );
      }
      if (peca && pecaCriaAgente(peca) && !naEquipeDecl.has(k)) {
        falha(
          'invalid_team_inheritance',
          `doSegmento.naoHerda.${k}`,
          'a peça do agente de um membro que não está na equipe já sai sozinha; não a liste.',
        );
      }
      if (
        (segmento.pecas ?? []).some((p) => p.chave === k) ||
        (segmento.faltaPouco ?? []).some((i) => i.chave === k)
      ) {
        falha(
          'invalid_team_inheritance',
          `doSegmento.naoHerda.${k}`,
          'não há substituição por mesma chave; a versão própria usa chave própria.',
        );
      }
    }
  }

  const pecasDoAmplo = base.pecas.filter((p) => !naoHerda.has(p.chave));
  let pecas = juntar<TeamPeca>('pecas', pecasDoAmplo, segmento?.pecas ?? [], amploSlug);

  // Peça de agente do amplo cujo membro NÃO está na equipe do especialista não é montada; peça herdada que será montada e
  // referencia esse agente reprova (não há como montá-la sem ele).
  if (segmento) {
    const naEquipe = new Set(equipe.map((e) => e.chave));
    const foraDaEquipe = new Set(
      pecas
        .filter((p) => p.origem === 'amplo' && pecaCriaAgente(p) && !naEquipe.has(p.chave))
        .map((p) => p.chave),
    );
    pecas = pecas.filter((p) => !foraDaEquipe.has(p.chave));
    for (const p of pecas) {
      const r = referenciasDaPeca(p);
      for (const ref of [...r.montar, ...r.desfazer]) {
        if (foraDaEquipe.has(ref)) {
          falha(
            'invalid_team_inheritance',
            `pecas.${p.chave}`,
            `referencia "${ref}", agente do amplo "${amploSlug}" que não está na equipe deste especialista: liste "${p.chave}" em doSegmento.naoHerda ou declare o membro.`,
          );
        }
      }
    }
  }

  // Peça listada em `naoHerda` não pode ser citada por peça que fica.
  if (naoHerda.size > 0) {
    for (const p of pecas) {
      const r = referenciasDaPeca(p);
      for (const ref of [...r.montar, ...r.desfazer]) {
        if (naoHerda.has(ref)) {
          falha(
            'invalid_team_inheritance',
            `pecas.${p.chave}`,
            `referencia "${ref}", peça do amplo listada em doSegmento.naoHerda; liste também "${p.chave}".`,
          );
        }
      }
    }
  }

  // Item do «Falta pouco» herdado cuja condição aponta para peça que não será montada sai junto (D39 d).
  const pecasMontadas = new Set(pecas.map((p) => p.chave));
  const pecasDoAmploNomes = new Set(base.pecas.map((p) => p.chave));
  const faltaDoAmplo = base.faltaPouco.filter((i) => {
    if (naoHerda.has(i.chave)) return false;
    return !(
      segmento &&
      i.feito.peca &&
      pecasDoAmploNomes.has(i.feito.peca) &&
      !pecasMontadas.has(i.feito.peca)
    );
  });
  const faltaPouco = juntar<TeamItemFaltaPouco>(
    'faltaPouco',
    faltaDoAmplo,
    segmento?.faltaPouco ?? [],
    amploSlug,
  );

  // Trecho acrescentado ao prompt de um agente do amplo (o especialista NÃO troca o prompt, só soma).
  for (const [chaveDaPeca, acrescimo] of Object.entries(segmento?.promptAcrescimo ?? {})) {
    const alvo = pecas.find((p) => p.chave === chaveDaPeca && p.origem === 'amplo');
    const prompt = alvo?.call?.argumentos['systemPrompt'];
    if (!alvo || !alvo.call || typeof prompt !== 'string') {
      falha(
        'invalid_team_inheritance',
        `doSegmento.promptAcrescimo.${chaveDaPeca}`,
        `o amplo "${amploSlug ?? '?'}" não tem peça de agente com "systemPrompt" nessa chave.`,
      );
    }
    alvo.call = {
      ...alvo.call,
      argumentos: {
        ...alvo.call.argumentos,
        systemPrompt: `${prompt.trimEnd()}\n\n${acrescimo.trim()}`,
      },
    };
  }

  // Regras comuns (D4) sobre o time final: a lista de peças é a que a montagem percorre, na ordem.
  const regras = regrasDoTimeResolvido(
    { liberado: m.liberado, equipe, pecas, faltaPouco },
    { equipe: 'equipe', pecas: 'pecas', faltaPouco: 'faltaPouco' },
  );
  if (regras.length > 0) throw new Falha(regras[0]);

  return {
    slug: m.slug,
    tipo: m.tipo,
    area: m.area,
    segmento: m.tipo === 'especialista' ? m.segmento : null,
    herda: m.tipo === 'especialista' ? m.herda : null,
    segmentoRotulo: m.tipo === 'especialista' ? m.segmentoRotulo : null,
    versao: m.versao,
    liberado: m.liberado,
    avisoParceiro: m.avisoParceiro,
    tamanho: m.tamanho,
    vitrine: m.vitrine,
    equipe,
    naoHerda: [...naoHerda],
    pecas,
    faltaPouco,
  };
}

/**
 * `resolverTime(amplo, especialista)` — o time final (soma, `naoHerda`, `promptAcrescimo`), igual ao que o carregador do
 * Hub faz hoje. Sem o segundo argumento resolve o amplo sozinho. Não lança: o primeiro erro vem em `issues` e `time` é `null`.
 * As entradas têm de ter passado em `validateTeamSpecStructure`.
 */
export function resolverTime(amplo: TeamSpec, especialista?: TeamSpec): ResolucaoDoTime {
  try {
    if (!especialista) {
      if (amplo.tipo !== 'amplo') {
        falha(
          'invalid_team_inheritance',
          'herda',
          `"${amplo.slug}" é um especialista: informe o amplo "${amplo.herda}".`,
        );
      }
      return { time: resolver(null, amplo), issues: [] };
    }
    if (amplo.tipo !== 'amplo') {
      falha(
        'invalid_team_inheritance',
        'herda',
        `"${amplo.slug}" é um especialista; só se herda de um time amplo.`,
      );
    }
    if (especialista.tipo !== 'especialista') {
      falha('invalid_team_inheritance', 'tipo', `"${especialista.slug}" não é um especialista.`);
    }
    if (especialista.herda !== amplo.slug) {
      falha(
        'invalid_team_inheritance',
        'herda',
        `"${especialista.herda}" não é o amplo informado ("${amplo.slug}").`,
      );
    }
    if (especialista.area !== amplo.area) {
      falha(
        'invalid_team_inheritance',
        'area',
        `"${especialista.area}" é diferente da área do amplo "${amplo.slug}" ("${amplo.area}").`,
      );
    }
    return { time: resolver(amplo, especialista), issues: [] };
  } catch (e) {
    if (e instanceof Falha) return { time: null, issues: [e.issue] };
    throw e;
  }
}

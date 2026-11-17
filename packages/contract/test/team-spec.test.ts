import { describe, expect, it } from 'vitest';
import {
  SPEC_KINDS,
  parseSpecYaml,
  resolverTime,
  serializeSpecYaml,
  validateSpecStructure,
  validateSpecStructureAs,
  validateTeamSpecStructure,
  type SpecIssue,
  type TeamAmploSpec,
  type TeamEspecialistaSpec,
} from '../src/index.js';

// Fixtures SINTÉTICAS (ADR-290 R5): nenhum texto, nome ou prompt de time real entra no pacote. Os 24 `time.yaml` do Hub
// são caso de teste do Hub (F3), não deste repositório.

const t3 = (pt: string) => ({ pt, en: `${pt} (en)`, es: `${pt} (es)` });

const vitrine = () => ({
  nome: t3('Time Exemplo'),
  frase: t3('Atende e vende sem parar'),
  naPratica: [t3('Passo um'), t3('Passo dois'), t3('Passo três')],
  canaisSugeridos: t3('WhatsApp'),
  depoisSoVoceFaz: t3('Conectar o canal'),
  cena: 'cena-exemplo',
});

const membro = (chave: string, papel: 'principal' | 'sub-agente' = 'principal') => ({
  chave,
  papel,
  nome: t3(`Nome ${chave}`),
  papelTitulo: t3(`Papel ${chave}`),
  oQueFaz: t3(`Faz ${chave}`),
  perfilDeModelo: 'recomendado' as const,
});

const pecaAgente = (chave: string, extra: Record<string, unknown> = {}) => ({
  chave,
  rotulo: t3(`Agente ${chave}`),
  grupo: 'agentes' as const,
  call: {
    ferramenta: 'agents-crt',
    argumentos: { name: chave, systemPrompt: `Prompt de ${chave}.` },
    desfazer: 'agents-remove',
  },
  ...extra,
});

const pecaFunil = (chave: string, argumentos: Record<string, unknown> = {}) => ({
  chave,
  rotulo: t3(`Funil ${chave}`),
  grupo: 'crm' as const,
  call: { ferramenta: 'pipelines-crt', argumentos, desfazer: 'pipelines-remove' },
});

const amplo = (mut: (a: TeamAmploSpec) => void = () => undefined): TeamAmploSpec => {
  const a: TeamAmploSpec = {
    spec_version: 'v1',
    kind: 'team',
    slug: 'comercial-exemplo',
    area: 'comercial',
    versao: 1,
    liberado: false,
    avisoParceiro: false,
    tamanho: 'grande',
    tipo: 'amplo',
    vitrine: vitrine(),
    equipe: [membro('ana'), membro('beto', 'sub-agente')],
    pecas: [
      pecaAgente('ana'),
      pecaAgente('beto'),
      pecaFunil('funil', { agentId: '${peca:ana.id}' }),
    ],
    faltaPouco: [
      {
        chave: 'ligar-ana',
        obrigatorio: true,
        texto: t3('Ligar a Ana'),
        destino: 'agentes',
        feito: { tipo: 'agente-ativo', peca: 'ana' },
      },
    ],
  };
  mut(a);
  return a;
};

const especialista = (
  mut: (e: TeamEspecialistaSpec) => void = () => undefined,
): TeamEspecialistaSpec => {
  const e: TeamEspecialistaSpec = {
    spec_version: 'v1',
    kind: 'team',
    slug: 'comercial-exemplo-clinica',
    area: 'comercial',
    versao: 1,
    liberado: false,
    avisoParceiro: false,
    tamanho: 'pequeno',
    tipo: 'especialista',
    vitrine: vitrine(),
    segmento: 'clinica',
    segmentoRotulo: t3('Clínicas'),
    herda: 'comercial-exemplo',
    doSegmento: {
      equipe: [membro('ana'), membro('caio', 'sub-agente')],
      pecas: [pecaAgente('caio')],
    },
  };
  mut(e);
  return e;
};

const codes = (issues: SpecIssue[]) => issues.map((i) => i.code);
const achar = (issues: SpecIssue[], code: string) => issues.find((i) => i.code === code);

describe('kind team — portão 1', () => {
  it('amplo e especialista válidos não têm erro', () => {
    expect(validateTeamSpecStructure(amplo())).toEqual([]);
    expect(validateTeamSpecStructure(especialista())).toEqual([]);
  });

  it('o kind entra em SPEC_KINDS e o dispatcher o julga', () => {
    expect(SPEC_KINDS).toContain('team');
    expect(validateSpecStructure(amplo() as never)).toEqual([]);
    expect(validateSpecStructureAs('team', amplo() as never)).toEqual([]);
    const errado = validateSpecStructureAs('agent', amplo() as never);
    expect(codes(errado)).toEqual(['kind_mismatch']);
  });

  it('o arquivo sobrevive ao ciclo YAML', () => {
    const lido = parseSpecYaml(serializeSpecYaml(amplo() as never));
    expect(validateTeamSpecStructure(lido)).toEqual([]);
  });

  it('documento vazio e versão desconhecida', () => {
    expect(codes(validateSpecStructure(null))).toEqual(['invalid_document']);
    const v = validateTeamSpecStructure({ ...amplo(), spec_version: 'v9' });
    expect(achar(v, 'unknown_spec_version')?.path).toBe('spec_version');
  });

  it('slug fora da regra reprova com invalid_slug', () => {
    const issues = validateTeamSpecStructure({ ...amplo(), slug: 'Comercial Exemplo' });
    expect(achar(issues, 'invalid_slug')?.path).toBe('slug');
  });

  it('campo desconhecido reprova (esquema estrito)', () => {
    const issues = validateTeamSpecStructure({ ...amplo(), requisitos: {} });
    const i = achar(issues, 'invalid_field_value');
    expect(i?.message).toContain('campo não reconhecido');
  });

  it('rótulo de peça acima de 80 caracteres reprova, com o idioma no path', () => {
    const issues = validateTeamSpecStructure(
      amplo((a) => {
        a.pecas[0].rotulo = { ...a.pecas[0].rotulo, es: 'x'.repeat(81) };
      }),
    );
    const i = achar(issues, 'invalid_field_value');
    expect(i?.path).toBe('pecas[0].rotulo.es');
    expect(i?.message).toContain('no máximo 80');
  });

  it('80 caracteres ainda passam', () => {
    const issues = validateTeamSpecStructure(
      amplo((a) => {
        a.pecas[0].rotulo = { pt: 'x'.repeat(80), en: 'x'.repeat(80), es: 'x'.repeat(80) };
      }),
    );
    expect(issues).toEqual([]);
  });

  it('rótulo sem um dos três idiomas reprova', () => {
    const a = amplo();
    const sem = { pt: 'a', en: 'b' } as never;
    a.pecas[0].rotulo = sem;
    const issues = validateTeamSpecStructure(a);
    expect(issues.some((i) => i.path === 'pecas[0].rotulo.es')).toBe(true);
  });

  it('frase acima de 110 e «Na prática» fora de 3 a 4 reprovam', () => {
    const longa = validateTeamSpecStructure(
      amplo((a) => {
        a.vitrine.frase = { ...a.vitrine.frase, pt: 'x'.repeat(111) };
      }),
    );
    expect(achar(longa, 'invalid_field_value')?.path).toBe('vitrine.frase.pt');
    const curto = validateTeamSpecStructure(
      amplo((a) => {
        a.vitrine.naPratica = [t3('um'), t3('dois')];
      }),
    );
    expect(achar(curto, 'invalid_field_value')?.path).toBe('vitrine.naPratica');
  });

  it('grupo, área e perfil de modelo fora da lista reprovam', () => {
    const g = validateTeamSpecStructure(
      amplo((a) => {
        (a.pecas[0] as { grupo: string }).grupo = 'financas';
      }),
    );
    expect(achar(g, 'invalid_field_value')?.path).toBe('pecas[0].grupo');
    const ar = validateTeamSpecStructure({ ...amplo(), area: 'juridico' });
    expect(achar(ar, 'invalid_field_value')?.path).toBe('area');
    const p = validateTeamSpecStructure(
      amplo((a) => {
        (a.equipe[0] as { perfilDeModelo: string }).perfilDeModelo = 'gpt';
      }),
    );
    expect(achar(p, 'invalid_field_value')?.path).toBe('equipe[0].perfilDeModelo');
  });

  it('D4 — chave repetida (equipe, peças, «Falta pouco») reprova com o path da repetida', () => {
    const peca = validateTeamSpecStructure(
      amplo((a) => {
        a.pecas.push(pecaFunil('ana'));
      }),
    );
    expect(achar(peca, 'duplicate_team_key')?.path).toBe('pecas[3].chave');
    const eq = validateTeamSpecStructure(
      amplo((a) => {
        a.equipe.push(membro('ana'));
      }),
    );
    expect(achar(eq, 'duplicate_team_key')?.path).toBe('equipe[2].chave');
    const fp = validateTeamSpecStructure(
      amplo((a) => {
        a.faltaPouco.push({ ...a.faltaPouco[0] });
      }),
    );
    expect(achar(fp, 'duplicate_team_key')?.path).toBe('faltaPouco[1].chave');
  });

  it('D4 — ${peca:x.id} só aponta para peça ANTERIOR', () => {
    const issues = validateTeamSpecStructure(
      amplo((a) => {
        a.pecas = [
          pecaFunil('funil', { agentId: '${peca:ana.id}' }),
          pecaAgente('ana'),
          pecaAgente('beto'),
        ];
      }),
    );
    const i = achar(issues, 'invalid_piece_reference');
    expect(i?.path).toBe('pecas[0].call.argumentos');
    expect(i?.message).toContain('"ana"');
  });

  it('D4 — referência aninhada em argumentos também é julgada', () => {
    const issues = validateTeamSpecStructure(
      amplo((a) => {
        a.pecas[2] = pecaFunil('funil', { etapas: [{ agente: '${peca:fantasma.id}' }] });
      }),
    );
    expect(achar(issues, 'invalid_piece_reference')?.message).toContain('"fantasma"');
  });

  it('D4 — desfazerArgumentos só cita peça que existe no time', () => {
    const issues = validateTeamSpecStructure(
      amplo((a) => {
        a.pecas[2].call = {
          ...a.pecas[2].call!,
          desfazerArgumentos: { id: '${peca:nao-existe.id}' },
        };
      }),
    );
    expect(achar(issues, 'invalid_piece_reference')?.path).toBe('pecas[2].call.desfazerArgumentos');
  });

  it('D4 — desfazer null exige semDesfazer', () => {
    const sem = validateTeamSpecStructure(
      amplo((a) => {
        a.pecas[2].call = {
          ferramenta: 'aplicativos-instalar-aplicativo',
          argumentos: {},
          desfazer: null,
        };
      }),
    );
    expect(achar(sem, 'undo_reason_missing')?.path).toBe('pecas[2].call.semDesfazer');
    const com = validateTeamSpecStructure(
      amplo((a) => {
        a.pecas[2].call = {
          ferramenta: 'aplicativos-instalar-aplicativo',
          argumentos: {},
          desfazer: null,
          semDesfazer: t3('O aplicativo não se desinstala sozinho'),
        };
      }),
    );
    expect(com).toEqual([]);
  });

  it('D4 — time liberado não tem peça «Em breve»; não liberado pode', () => {
    const lib = validateTeamSpecStructure(
      amplo((a) => {
        a.liberado = true;
        a.pecas[2].emBreve = true;
      }),
    );
    expect(achar(lib, 'released_team_with_em_breve')?.path).toBe('pecas[2].emBreve');
    const rascunho = validateTeamSpecStructure(
      amplo((a) => {
        a.pecas[2].emBreve = true;
      }),
    );
    expect(rascunho).toEqual([]);
  });

  it('peça precisa de exatamente uma forma: call OU spec', () => {
    const nenhuma = validateTeamSpecStructure(
      amplo((a) => {
        delete a.pecas[2].call;
      }),
    );
    expect(achar(nenhuma, 'invalid_team_piece')?.path).toBe('pecas[2]');
    const duas = validateTeamSpecStructure(
      amplo((a) => {
        a.pecas[2].spec = { kind: 'journey', arquivo: 'jornadas/x.yaml' };
      }),
    );
    expect(achar(duas, 'invalid_team_piece')?.message).toContain('só uma forma');
  });

  it('peça spec: aceita um tipo declarativo do ADK e recusa kind fora da lista', () => {
    const ok = validateTeamSpecStructure(
      amplo((a) => {
        a.pecas[2] = {
          chave: 'jornada',
          rotulo: t3('Jornada de boas-vindas'),
          grupo: 'jornadas',
          spec: { kind: 'journey', arquivo: 'jornadas/boas-vindas.yaml' },
        };
      }),
    );
    expect(ok).toEqual([]);
    const ruim = validateTeamSpecStructure(
      amplo((a) => {
        a.pecas[2] = {
          chave: 'jornada',
          rotulo: t3('Jornada'),
          grupo: 'jornadas',
          spec: { kind: 'funil' as never, arquivo: 'x.yaml' },
        };
      }),
    );
    expect(achar(ruim, 'invalid_field_value')?.path).toBe('pecas[2].spec.kind');
  });

  it('ativaAoLigar só em peça de jornada ou de acompanhamento (crm)', () => {
    const issues = validateTeamSpecStructure(
      amplo((a) => {
        a.pecas[0].ativaAoLigar = true;
      }),
    );
    expect(achar(issues, 'invalid_team_piece')?.path).toBe('pecas[0].ativaAoLigar');
  });

  it('equipe sem principal, peça de agente sem membro e «Falta pouco» com peça inexistente reprovam', () => {
    const sp = validateTeamSpecStructure(
      amplo((a) => {
        a.equipe = [membro('ana', 'sub-agente'), membro('beto', 'sub-agente')];
      }),
    );
    expect(codes(sp)).toContain('team_without_principal');
    const sm = validateTeamSpecStructure(
      amplo((a) => {
        a.pecas.push(pecaAgente('zeca'));
      }),
    );
    expect(achar(sm, 'agent_piece_without_member')?.path).toBe('pecas[3].chave');
    const fp = validateTeamSpecStructure(
      amplo((a) => {
        a.faltaPouco[0].feito = { tipo: 'agente-ativo', peca: 'nao-existe' };
      }),
    );
    expect(achar(fp, 'unknown_team_piece')?.path).toBe('faltaPouco[0].feito.peca');
  });

  it('condição de feito exige o campo do tipo', () => {
    const issues = validateTeamSpecStructure(
      amplo((a) => {
        a.faltaPouco[0].feito = { tipo: 'canal-conectado' };
      }),
    );
    expect(achar(issues, 'invalid_field_value')?.path).toBe('faltaPouco[0].feito.canal');
  });

  it('especialista: chave repetida na própria soma e peça sem forma reprovam já no arquivo', () => {
    const dup = validateTeamSpecStructure(
      especialista((e) => {
        e.doSegmento.pecas = [pecaAgente('caio'), pecaAgente('caio')];
      }),
    );
    expect(achar(dup, 'duplicate_team_key')?.path).toBe('doSegmento.pecas[1].chave');
    const sem = validateTeamSpecStructure(
      especialista((e) => {
        delete e.doSegmento.pecas![0].call;
      }),
    );
    expect(achar(sem, 'invalid_team_piece')?.path).toBe('doSegmento.pecas[0]');
  });
});

describe('resolverTime — herança amplo → segmento (D5)', () => {
  it('soma equipe própria do segmento, peças e marca a origem', () => {
    const r = resolverTime(amplo(), especialista());
    expect(r.issues).toEqual([]);
    const t = r.time!;
    // A equipe do especialista é a DELE inteira (D34), não a soma.
    expect(t.equipe.map((e) => [e.chave, e.origem])).toEqual([
      ['ana', 'amplo'],
      ['caio', 'segmento'],
    ]);
    // beto não está na equipe do especialista: a peça do agente dele sai sozinha.
    expect(t.pecas.map((p) => [p.chave, p.origem])).toEqual([
      ['ana', 'amplo'],
      ['funil', 'amplo'],
      ['caio', 'segmento'],
    ]);
    expect(t.herda).toBe('comercial-exemplo');
    expect(t.segmento).toBe('clinica');
  });

  it('amplo sozinho resolve para ele mesmo', () => {
    const r = resolverTime(amplo());
    expect(r.time?.pecas.map((p) => p.origem)).toEqual(['amplo', 'amplo', 'amplo']);
    expect(r.time?.segmento).toBeNull();
  });

  it('promptAcrescimo soma ao systemPrompt sem alterar a entrada', () => {
    const base = amplo();
    const esp = especialista((e) => {
      e.doSegmento.promptAcrescimo = { ana: '  Atenda também por convênio.  ' };
    });
    const antes = JSON.stringify(base);
    const r = resolverTime(base, esp);
    expect(r.issues).toEqual([]);
    const ana = r.time!.pecas.find((p) => p.chave === 'ana')!;
    expect(ana.call?.argumentos['systemPrompt']).toBe(
      'Prompt de ana.\n\nAtenda também por convênio.',
    );
    expect(JSON.stringify(base)).toBe(antes);
  });

  it('promptAcrescimo em peça sem systemPrompt reprova', () => {
    const r = resolverTime(
      amplo(),
      especialista((e) => {
        e.doSegmento.promptAcrescimo = { funil: 'x' };
      }),
    );
    expect(r.time).toBeNull();
    expect(r.issues[0].code).toBe('invalid_team_inheritance');
    expect(r.issues[0].path).toBe('doSegmento.promptAcrescimo.funil');
  });

  it('naoHerda tira a peça e o item de «Falta pouco» que dependia dela', () => {
    const r = resolverTime(
      amplo(),
      especialista((e) => {
        e.doSegmento.naoHerda = ['funil'];
        e.doSegmento.equipe = [membro('ana'), membro('beto', 'sub-agente')];
        e.doSegmento.pecas = [];
      }),
    );
    expect(r.issues).toEqual([]);
    expect(r.time!.pecas.map((p) => p.chave)).toEqual(['ana', 'beto']);
    expect(r.time!.naoHerda).toEqual(['funil']);
  });

  it('item do «Falta pouco» herdado some com a peça que não é montada', () => {
    const r = resolverTime(
      amplo(),
      especialista((e) => {
        // ana fica fora da equipe: a peça dela sai sozinha e o item que a cita sai junto.
        e.doSegmento.equipe = [membro('caio'), membro('beto', 'sub-agente')];
        e.doSegmento.naoHerda = ['funil'];
      }),
    );
    expect(r.issues).toEqual([]);
    expect(r.time!.faltaPouco).toEqual([]);
  });

  it('naoHerda de chave que o amplo não tem reprova', () => {
    const r = resolverTime(
      amplo(),
      especialista((e) => {
        e.doSegmento.naoHerda = ['fantasma'];
      }),
    );
    expect(r.issues[0].code).toBe('invalid_team_inheritance');
    expect(r.issues[0].path).toBe('doSegmento.naoHerda.fantasma');
  });

  it('naoHerda da peça de agente de membro fora da equipe reprova: ela já sai sozinha', () => {
    const r = resolverTime(
      amplo(),
      especialista((e) => {
        // beto não está na equipe do especialista: a peça dele já sai sozinha.
        e.doSegmento.naoHerda = ['beto'];
      }),
    );
    expect(r.time).toBeNull();
    expect(r.issues[0].code).toBe('invalid_team_inheritance');
    expect(r.issues[0].path).toBe('doSegmento.naoHerda.beto');
    expect(r.issues[0].message).toContain('já sai sozinha');
  });

  it('naoHerda de chave que o segmento também declara reprova: não há substituição', () => {
    const r = resolverTime(
      amplo(),
      especialista((e) => {
        e.doSegmento.naoHerda = ['funil'];
        e.doSegmento.pecas = [pecaAgente('caio'), pecaFunil('funil')];
      }),
    );
    expect(r.time).toBeNull();
    expect(r.issues[0].code).toBe('invalid_team_inheritance');
    expect(r.issues[0].path).toBe('doSegmento.naoHerda.funil');
    expect(r.issues[0].message).toContain('não há substituição');
  });

  it('peça que fica e cita peça listada em naoHerda reprova: liste também a que cita', () => {
    const r = resolverTime(
      amplo(),
      especialista((e) => {
        // o funil cita ${peca:ana.id}; ana sai (naoHerda) e o funil fica.
        e.doSegmento.naoHerda = ['ana'];
      }),
    );
    expect(r.time).toBeNull();
    expect(r.issues[0].code).toBe('invalid_team_inheritance');
    expect(r.issues[0].path).toBe('pecas.funil');
    expect(r.issues[0].message).toContain('liste também "funil"');
  });

  it('chave de peça repetida entre amplo e segmento reprova e cita o amplo', () => {
    const r = resolverTime(
      amplo(),
      especialista((e) => {
        e.doSegmento.pecas = [pecaAgente('ana')];
      }),
    );
    expect(r.issues[0].code).toBe('duplicate_team_key');
    expect(r.issues[0].message).toContain('o amplo "comercial-exemplo" já tem essa chave');
  });

  it('o mesmo membro com papel diferente do amplo reprova', () => {
    const r = resolverTime(
      amplo(),
      especialista((e) => {
        e.doSegmento.equipe = [membro('ana', 'sub-agente'), membro('caio')];
      }),
    );
    expect(r.issues[0].code).toBe('invalid_team_inheritance');
    expect(r.issues[0].path).toBe('doSegmento.equipe[0].papel');
  });

  it('peça herdada que referencia agente fora da equipe do especialista reprova', () => {
    const base = amplo((a) => {
      a.pecas[2] = pecaFunil('funil', { agentId: '${peca:beto.id}' });
    });
    const r = resolverTime(
      base,
      especialista((e) => {
        e.doSegmento.equipe = [membro('ana'), membro('caio', 'sub-agente')];
      }),
    );
    expect(r.issues[0].code).toBe('invalid_team_inheritance');
    expect(r.issues[0].message).toContain('"beto"');
  });

  it('herda do amplo errado, de outra área ou de um especialista reprova', () => {
    const outro = resolverTime(
      amplo((a) => (a.slug = 'outro-amplo')),
      especialista(),
    );
    expect(outro.issues[0].path).toBe('herda');
    const area = resolverTime(
      amplo((a) => (a.area = 'rh')),
      especialista(),
    );
    expect(area.issues[0].path).toBe('area');
    const filho = resolverTime(especialista(), especialista());
    expect(filho.issues[0].message).toContain('só se herda de um time amplo');
    const sozinho = resolverTime(especialista());
    expect(sozinho.issues[0].code).toBe('invalid_team_inheritance');
  });

  it('as regras do time final valem depois da soma (referência a peça posterior, liberado com «Em breve»)', () => {
    const posterior = resolverTime(
      amplo(),
      especialista((e) => {
        e.doSegmento.pecas = [pecaAgente('caio'), pecaFunil('funil-2', { x: '${peca:zzz.id}' })];
      }),
    );
    expect(posterior.issues[0].code).toBe('invalid_piece_reference');
    const emBreve = resolverTime(
      amplo(),
      especialista((e) => {
        e.liberado = true;
        e.doSegmento.pecas = [pecaAgente('caio', { emBreve: true })];
      }),
    );
    expect(emBreve.issues[0].code).toBe('released_team_with_em_breve');
  });
});

describe('TC2 (Hub#2.6.27.48) — condições novas de «feito», automação e peça que atualiza outra', () => {
  const comFeito = (feito: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    amplo((a) => {
      a.faltaPouco[0] = { ...a.faltaPouco[0], feito, ...extra } as never;
    });

  it.each([
    ['responsavel-definido', { tipo: 'responsavel-definido' }],
    ['catalogo-com-item', { tipo: 'catalogo-com-item' }],
    ['integracao-conectada', { tipo: 'integracao-conectada', integracao: 'google-agenda' }],
    ['acompanhamento-ativo', { tipo: 'acompanhamento-ativo', peca: 'ana' }],
    ['email-do-agente-ligado', { tipo: 'email-do-agente-ligado', peca: 'ana' }],
    ['canal-conectado com lista', { tipo: 'canal-conectado', canais: ['whatsapp-oficial', 'instagram'] }],
  ])('condição «%s» é aceita', (_n, feito) => {
    expect(validateTeamSpecStructure(comFeito(feito))).toEqual([]);
  });

  it('integracao-conectada sem integração reprova; integração em outro tipo também', () => {
    expect(
      achar(validateTeamSpecStructure(comFeito({ tipo: 'integracao-conectada' })), 'invalid_field_value')?.path,
    ).toBe('faltaPouco[0].feito.integracao');
    expect(
      achar(
        validateTeamSpecStructure(comFeito({ tipo: 'catalogo-com-item', integracao: 'google-agenda' })),
        'invalid_field_value',
      )?.path,
    ).toBe('faltaPouco[0].feito.integracao');
  });

  it('acompanhamento-ativo e email-do-agente-ligado exigem a peça, e a peça tem de existir', () => {
    for (const tipo of ['acompanhamento-ativo', 'email-do-agente-ligado']) {
      expect(achar(validateTeamSpecStructure(comFeito({ tipo })), 'invalid_field_value')?.path).toBe(
        'faltaPouco[0].feito.peca',
      );
      expect(
        achar(validateTeamSpecStructure(comFeito({ tipo, peca: 'nao-existe' })), 'unknown_team_piece')?.path,
      ).toBe('faltaPouco[0].feito.peca');
    }
  });

  it('canal-conectado: «canal» ou «canais», nunca os dois nem nenhum; lista vazia reprova', () => {
    const ambos = validateTeamSpecStructure(
      comFeito({ tipo: 'canal-conectado', canal: 'whatsapp-oficial', canais: ['instagram'] }),
    );
    expect(achar(ambos, 'invalid_field_value')?.path).toBe('faltaPouco[0].feito.canais');
    const nenhum = validateTeamSpecStructure(comFeito({ tipo: 'canal-conectado' }));
    expect(achar(nenhum, 'invalid_field_value')?.path).toBe('faltaPouco[0].feito.canal');
    const vazia = validateTeamSpecStructure(comFeito({ tipo: 'canal-conectado', canais: [] }));
    expect(vazia.length).toBeGreaterThan(0);
  });

  it('«canal» e «canais» fora de canal-conectado reprovam', () => {
    const issues = validateTeamSpecStructure(
      comFeito({ tipo: 'responsavel-definido', canais: ['instagram'] }),
    );
    expect(achar(issues, 'invalid_field_value')?.path).toBe('faltaPouco[0].feito.canais');
  });

  it('tipo de condição desconhecido continua reprovando', () => {
    expect(validateTeamSpecStructure(comFeito({ tipo: 'inventado' })).length).toBeGreaterThan(0);
  });

  it('gastaAutomacao é booleano opcional no item; texto reprova', () => {
    expect(validateTeamSpecStructure(comFeito({ tipo: 'responsavel-definido' }, { gastaAutomacao: true }))).toEqual([]);
    expect(
      validateTeamSpecStructure(comFeito({ tipo: 'responsavel-definido' }, { gastaAutomacao: 'sim' })).length,
    ).toBeGreaterThan(0);
  });

  it('peça de acompanhamento (grupo crm) pode nascer desligada; em outro grupo, não', () => {
    const crm = amplo((a) => {
      a.pecas.push({ ...pecaFunil('acompanhamento'), ativaAoLigar: false } as never);
    });
    expect(validateTeamSpecStructure(crm)).toEqual([]);
    const agente = amplo((a) => {
      a.pecas[0] = { ...a.pecas[0], ativaAoLigar: false } as never;
    });
    expect(achar(validateTeamSpecStructure(agente), 'invalid_team_piece')?.path).toBe('pecas[0].ativaAoLigar');
  });

  const atualizaAna = (extra: Record<string, unknown> = {}) => ({
    chave: 'ana-com-funil',
    rotulo: t3('Liga a Ana ao funil'),
    grupo: 'agentes' as const,
    atualiza: 'ana',
    call: {
      ferramenta: 'agents-upd',
      argumentos: { id: '${peca:ana.id}', pipelineId: '${peca:funil.id}' },
      desfazer: null,
      semDesfazer: undefined,
    },
    ...extra,
  });

  it('peça que atualiza a peça-mãe anterior desfaz junto: dispensa «semDesfazer»', () => {
    const t = amplo((a) => {
      a.pecas.push(atualizaAna() as never);
    });
    expect(validateTeamSpecStructure(t)).toEqual([]);
  });

  it('sem «atualiza», desfazer null continua exigindo «semDesfazer»', () => {
    const t = amplo((a) => {
      a.pecas.push(atualizaAna({ atualiza: undefined }) as never);
    });
    expect(achar(validateTeamSpecStructure(t), 'undo_reason_missing')).toBeDefined();
  });

  it('«atualiza» tem de apontar para peça ANTERIOR (não posterior, não a própria, não inexistente)', () => {
    const posterior = amplo((a) => {
      a.pecas.unshift(atualizaAna() as never);
    });
    expect(achar(validateTeamSpecStructure(posterior), 'invalid_piece_reference')?.path).toBe('pecas[0].atualiza');
    const propria = amplo((a) => {
      a.pecas.push(atualizaAna({ atualiza: 'ana-com-funil' }) as never);
    });
    expect(achar(validateTeamSpecStructure(propria), 'invalid_piece_reference')?.path).toBe('pecas[3].atualiza');
    const inexistente = amplo((a) => {
      a.pecas.push(atualizaAna({ atualiza: 'zzz' }) as never);
    });
    expect(achar(validateTeamSpecStructure(inexistente), 'invalid_piece_reference')?.path).toBe('pecas[3].atualiza');
  });

  it('«atualiza» só vale em peça com «call»', () => {
    const t = amplo((a) => {
      a.pecas.push({
        chave: 'ana-2',
        rotulo: t3('Ana 2'),
        grupo: 'agentes',
        atualiza: 'ana',
        spec: { kind: 'agent', arquivo: 'agentes/ana.yaml' },
      } as never);
    });
    expect(achar(validateTeamSpecStructure(t), 'invalid_team_piece')?.path).toBe('pecas[3].atualiza');
  });

  it('especialista: «atualiza» pode apontar para peça herdada do amplo (julgada no time resolvido)', () => {
    const e = especialista((x) => {
      x.doSegmento.pecas = [pecaAgente('caio'), atualizaAna() as never];
    });
    expect(validateTeamSpecStructure(e)).toEqual([]);
    expect(resolverTime(amplo(), e).issues).toEqual([]);
  });

  it('especialista: «atualiza» sem «call» e desfazer null sem motivo reprovam já no arquivo', () => {
    const semCall = especialista((x) => {
      x.doSegmento.pecas = [
        {
          chave: 'caio-2',
          rotulo: t3('Caio 2'),
          grupo: 'agentes',
          atualiza: 'ana',
          spec: { kind: 'agent', arquivo: 'agentes/caio.yaml' },
        } as never,
      ];
    });
    expect(achar(validateTeamSpecStructure(semCall), 'invalid_team_piece')?.path).toBe(
      'doSegmento.pecas[0].atualiza',
    );
    const semMotivo = especialista((x) => {
      x.doSegmento.pecas = [atualizaAna({ atualiza: undefined }) as never];
    });
    expect(achar(validateTeamSpecStructure(semMotivo), 'undo_reason_missing')?.path).toBe(
      'doSegmento.pecas[0].call.semDesfazer',
    );
  });

  it('o time resolvido (amplo + segmento) também confere «atualiza»', () => {
    const r = resolverTime(
      amplo(),
      especialista((e) => {
        e.doSegmento.pecas = [pecaAgente('caio'), atualizaAna({ atualiza: 'zzz' }) as never];
      }),
    );
    expect(r.issues.some((i) => i.code === 'invalid_piece_reference')).toBe(true);
  });

  it('referência a etapa do funil: `${peca:<funil>.etapa.<Nome>.id}` vale se a etapa está em stages', () => {
    const funil = {
      ...pecaFunil('funil', { name: 'Vendas', stages: [{ name: 'Novo' }, { name: 'Proposta enviada' }] }),
    };
    const regra = (etapa: string, mae = 'funil') => ({
      chave: 'regra',
      rotulo: t3('Regra de etapa'),
      grupo: 'crm' as const,
      call: {
        ferramenta: 'pipelines-save-stage-rule',
        argumentos: { stageId: `\${peca:${mae}.etapa.${etapa}.id}` },
        desfazer: null,
        semDesfazer: t3('some junto com o funil'),
      },
    });
    const ok = amplo((a) => {
      a.pecas = [pecaAgente('ana'), pecaAgente('beto'), funil as never, regra('Proposta enviada') as never];
    });
    expect(validateTeamSpecStructure(ok)).toEqual([]);
    const inexistente = amplo((a) => {
      a.pecas = [pecaAgente('ana'), pecaAgente('beto'), funil as never, regra('Fechado') as never];
    });
    expect(achar(validateTeamSpecStructure(inexistente), 'unknown_pipeline_stage')?.path).toBe(
      'pecas[3].call.argumentos',
    );
    const maeErrada = amplo((a) => {
      a.pecas = [pecaAgente('ana'), pecaAgente('beto'), funil as never, regra('Novo', 'ana') as never];
    });
    expect(achar(validateTeamSpecStructure(maeErrada), 'invalid_piece_reference')).toBeDefined();
    const posterior = amplo((a) => {
      a.pecas = [pecaAgente('ana'), pecaAgente('beto'), regra('Novo') as never, funil as never];
    });
    expect(achar(validateTeamSpecStructure(posterior), 'invalid_piece_reference')).toBeDefined();
  });
});

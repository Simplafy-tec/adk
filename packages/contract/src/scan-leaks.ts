/**
 * Portão de vazamento — porte 1:1 de `scripts/validar.mjs` do simplafy-clientes
 * (origin/main), agora devolvendo `SpecIssue[]` em vez de string.
 *
 * Roda sem falar com o Hub, sobre o TEXTO do artefato: é por isso que ele
 * também vale do lado do servidor, que escaneia o spec serializado — mandar
 * `spec` JSON em vez de `yaml` não é rota de fuga (as regras de chave aceitam a
 * chave entre aspas, que é a única diferença das duas formas).
 *
 * O que ele impede, em ordem de gravidade:
 *   1. segredo versionado;  2. dado de contato (PII);  3. identificador
 *   interno no lugar de nome legível;  4. contexto de turno;  5. identidade que
 *   não casa com o nome do arquivo.
 *
 * DIVERGÊNCIA CONHECIDA (issue#2808/issue#2817): `turn_context` aqui só acusa o
 * nome como CHAVE COM VALOR ao lado, e leitura de env var não é segredo. Duas
 * outras cópias mantêm a regra antiga (`text.includes`, sem neutralizar env):
 * o `validar.mjs` do simplafy-clientes e `apps/api/src/adk/scan-leaks.ts` do
 * hub-v2, que roda no EXPORT. O alinhamento das cópias é a issue#2816.
 *
 * DIVERGÊNCIA NOVA (issue#2853): a regra de atribuição aqui também ignora
 * (a) linha de comentário (`#` só em py/yaml/sh/toml/env; `//` e `/* … *\/`),
 * exceto em arquivo com sinal de string multilinha (aí nada é cortado), e
 * (b) `token = nome_de_funcao(...)` quando o resto da linha não tem aspa
 * nenhuma e o `)` fecha na mesma linha. As duas cópias acima NÃO têm essas
 * isenções e podem reprovar o que o `adk build` aceita (ex.:
 * `token = contexto.token_interno()`). Alinhar junto com a issue#2816.
 */

import type { SpecIssue, SpecIssueCode } from './spec-gates.js';

interface Regra {
  code: SpecIssueCode;
  re: RegExp;
  /** Sufixo da mensagem, no texto literal do validar.mjs. */
  mensagem: (oque: string) => string;
  oque: string;
  /** Grupo de captura que nomeia a chave ofendida, quando a regra é de chave. */
  chave?: number;
  /**
   * issue#2853 — regra de ATRIBUIÇÃO (casa forma, não segredo): roda sobre o
   * texto sem linha inteira de comentário e sem `x = f()` / `x = obj.metodo()`.
   * As regras de FORMATO inequívoco (`sk-…`, JWT, chave privada) NÃO levam a
   * flag: seguem valendo em qualquer posição do arquivo, comentário inclusive.
   */
  ignoraComentarioEChamada?: boolean;
}

/** Segredo nunca entra: credencial é referenciada por nome e resolvida no Hub. */
const SEGREDO: Regra[] = [
  {
    code: 'secret_literal',
    re: /\bsk[-_][A-Za-z0-9_-]{8,}/,
    oque: 'chave de API literal',
    mensagem: segredo,
  },
  // DIVERGÊNCIA DELIBERADA em relação ao `validar.mjs`, nas duas regras de
  // chave abaixo: o `["']?` depois do nome da chave não existe no original.
  // O validar.mjs só via YAML (`password: x`); aqui o mesmo scanner roda
  // também sobre o spec serializado como JSON (`"password": "x"`) — sem o
  // opcional, mandar `spec` em vez de `yaml` seria rota de fuga do portão.
  // Extensão, não drift: tudo que o original acusava continua acusado.
  //
  // Rodada 3, item 3 (paridade e documentação, pendência da rodada 2): o
  // contrato deste pacote é ESTRITAMENTE MAIS AMPLO que o `validar.mjs` do
  // simplafy-clientes, por decisão de segurança — todo formato abaixo é
  // aceito aqui e NÃO era pego pelo original:
  //   - `sk[-_]` (o original só reconhecia `sk-`, este pacote também pega
  //     `sk_live_…`, formato de chave da própria plataforma);
  //   - `[\w-]*` antes de `token|secret|api[_-]?key` (o original usava `\b`,
  //     que não casa depois de `_` — perdia `access_token`/`refresh_token`);
  //   - `[:=]` em vez de só `:` (pega `token = "…"`, não só `token: …`);
  //   - JWT literal (`\beyJ…\.…\.`), sem depender do nome da chave.
  // A parte 2 desta story (GATE 4) tem de alinhar o servidor a ESTE contrato
  // — hoje é a CLI (`adk validate`) que já roda isso de ponta a ponta contra
  // `orgs/*/vinculos/*.yaml`; o `apply` do Hub precisa escanear com as MESMAS
  // regras, senão um artefato aceito pela CLI e reprovado só pelo servidor
  // (ou vice-versa) quebra o mutation check do AC4.
  {
    code: 'secret_literal',
    re: /\b(password|senha)["']?\s*:\s*\S/i,
    oque: 'senha literal',
    mensagem: segredo,
    chave: 1,
  },
  // Rodada 2 (finding #2): `\b` não casa depois de `_` (ex.: `access_token`,
  // `refresh_token`), então trocado por `[\w-]*` no prefixo — casa a chave em
  // qualquer posição de um identificador composto. `[:=]` cobre `token = "…"`
  // além de `token: …`. `token_budget`/`api_key_name` continuam limpos: o
  // sufixo depois da chave (`_budget`, `_name`) quebra o `\s*[:=]` exigido
  // logo após o nome da chave.
  //
  // Rodada 3 (finding #1, block da review): o `[\w-]*` solto no início, sem
  // âncora à esquerda, é O(n²) — o motor tentava a alternação em toda posição
  // de um bloco contíguo de `[\w-]` antes de desistir (20 KB = 450 ms,
  // 200 KB = 48 s). `(?<![\w-])` faz o motor só tentar casar no INÍCIO de um
  // identificador — dentro de um bloco contíguo sem separador, só a posição 0
  // sobrevive ao lookbehind, então o trabalho cai para O(n). Mesmos 9 casos de
  // aceite/falso-positivo continuam batendo.
  {
    code: 'secret_literal',
    re: /(?<![\w-])[\w-]*(secret|api[_-]?key|token)["']?\s*[:=]\s*["']?[A-Za-z0-9_\-.]{12,}/i,
    oque: 'segredo literal',
    mensagem: segredo,
    chave: 1,
    ignoraComentarioEChamada: true,
  },
  {
    code: 'secret_literal',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    oque: 'chave privada',
    mensagem: segredo,
  },
  // Rodada 3 (finding #2): token da plataforma reconhecível pelo formato JWT
  // (header.payload.assinatura), independente do nome da chave que o precede
  // — pega `Authorization: Bearer eyJ…` mesmo sem `token:`/`api_key:` na frente.
  {
    code: 'secret_literal',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
    oque: 'token JWT literal',
    mensagem: segredo,
  },
];

/** Telefone e documento brasileiros soltos no arquivo. */
const PII: Regra[] = [
  { code: 'pii_in_config', re: /\b55\d{2}9?\d{8}\b/, oque: 'telefone brasileiro', mensagem: pii },
  { code: 'pii_in_config', re: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/, oque: 'CPF', mensagem: pii },
  {
    code: 'pii_in_config',
    re: /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/,
    oque: 'CNPJ',
    mensagem: pii,
  },
];

function segredo(oque: string): string {
  return `${oque} versionado — credencial é referenciada por nome`;
}

function pii(oque: string): string {
  return `${oque} no arquivo — dado de pessoa não é configuração`;
}

/**
 * Contexto do turno não descreve o agente — descreve QUEM falou com ele. Num
 * arquivo versionado isso é vazamento de dado pessoal, e é a razão de o
 * contrato Hub↔motor ter sido separado em grupos.
 */
export const CONTEXTO_DE_TURNO = [
  'oap_contact_phone',
  'oap_contact_name',
  'oap_contact_id',
  'oap_contact_jid',
  'oap_contact_context',
  'crm_lead_id',
  'crm_pipeline',
  'crm_phase',
  'crm_consultant',
  'oap_channel_conversation_id',
  'langfuse_session_id',
  'langfuse_user_id',
];

/** cuid/uuid onde deveria haver nome legível — o arquivo só valeria na origem. */
const ID_INTERNO =
  /\b(c[a-z0-9]{24,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/;

export interface ScanLeaksOptions {
  /** Caminho do artefato — dá o `path` das issues e a identidade esperada. */
  filename: string;
  /**
   * Confere `slug:` contra o nome do arquivo. Ligado por padrão (é o portão do
   * repositório de clientes); desligado para o `manifest.yaml` de um pacote de
   * tool, onde a identidade é a do pacote e não a do arquivo.
   */
  checkSlug?: boolean;
}

/** `#` só é comentário nestas extensões — em ts/js, `#campo` é campo privado. */
const EXT_HASH_COMENTARIO = /\.(?:py|ya?ml|sh|toml|env)$|(?:^|\/)\.env[\w.]*$/i;
const EXT_YAML = /\.ya?ml$/i;
/** `//` e `/* *\/` só são comentário em linguagens de sintaxe C (em .md/.yaml/.ini/.py é conteúdo). */
const EXT_BARRA_COMENTARIO = /\.(?:[cm]?[jt]sx?|css|scss|less|java|go|rs|c|cc|cpp|h|hpp|cs|kt|swift|php)$/i;

/**
 * Cabeçalho de escalar de bloco YAML, em forma FROUXA de propósito (rodada 2 da
 * review do PR simplafy-adk#37, item 4): qualquer linha que termina em `|`/`>`
 * (com indicador de indentação/chomping em qualquer ordem — `|2-`, `|-2`, `>+`)
 * depois de espaço ou no início, com tag/âncora antes (`!!str |`, `&p |`) e
 * comentário opcional depois. Reconhecer bloco a mais só faz o filtro cortar
 * MENOS — o erro possível é marcar, nunca esconder.
 */
const CABECALHO_BLOCO_YAML = /(?:^|[ \t])[|>][0-9+-]*[ \t]*(?:#.*)?$/;

/** Linha inteira de comentário pelas regras do arquivo (sem olhar estado de string). */
function ehComentario(linha: string, hash: boolean, barra: boolean): boolean {
  if (barra && /^[ \t]*\/\//.test(linha)) return true;
  if (hash && /^[ \t]*#/.test(linha)) return true;
  return barra && /^[ \t]*\/\*/.test(linha) && !/\*\//.test(linha);
}

/** Aspa sem par na linha (escape `\x` descontado): sinal de string multilinha. */
function aspaSemPar(trecho: string): boolean {
  const s = trecho.replace(/\\./g, '');
  return ['"', "'", '`'].some((q) => s.split(q).length % 2 === 0);
}

/**
 * Apaga só o que é comentário, nunca a atribuição que vem depois dele
 * (issue#2853, review do PR simplafy-adk#37):
 *  - `//` no início da linha, SÓ em arquivos de sintaxe C (js/ts/css/java/go…): em
 *    .md/.yaml/.ini/.py é conteúdo e continua escaneado;
 *  - `/* … *\/` no início da linha: remove só até o `*\/` (código depois fica);
 *    sem `*\/` na linha, a linha inteira é comentário;
 *  - `#` no início da linha SÓ em py/yaml/sh/toml/env — em ts/js é campo privado;
 *  - em YAML, linha dentro de escalar de bloco (`|`/`>`) é CONTEÚDO (prompt), não
 *    comentário: não é cortada.
 *
 * FAIL-CLOSED (rodada 2 da review): a mesma linha `# token: …` é CONTEÚDO quando
 * está dentro de string de aspas triplas Python, heredoc shell, template literal
 * ou string com aspas que atravessa linhas. Este filtro não rastreia esse estado
 * linha a linha; em vez disso, se o arquivo tem QUALQUER sinal de string
 * multilinha — `"""`, `'''`, `<<` (fora de YAML, onde `<<` é merge key) ou uma
 * linha de código com aspa sem par — NADA é neutralizado e a regra roda sobre o
 * texto cru, como na `main`. Custo: um arquivo com apóstrofo solto num comentário
 * de fim de linha volta a ser escaneado inteiro — falso positivo possível, nunca
 * segredo escondido.
 */
function neutralizaComentario(text: string, filename: string): string {
  const hash = EXT_HASH_COMENTARIO.test(filename);
  const barra = EXT_BARRA_COMENTARIO.test(filename);
  const yaml = EXT_YAML.test(filename);
  if (/"""|'''/.test(text) || (!yaml && /<</.test(text))) return text;

  let blocoIndent = -1; // indentação da chave que abriu o escalar de bloco
  let seguro = true;
  const linhas = text.split('\n').map((linha) => {
    const indent = linha.length - linha.trimStart().length;
    if (yaml && blocoIndent >= 0) {
      if (linha.trim() === '' || indent > blocoIndent) return linha;
      blocoIndent = -1;
    }
    if (yaml && CABECALHO_BLOCO_YAML.test(linha)) blocoIndent = indent;
    if (ehComentario(linha, hash, barra)) return '';
    let resto = linha;
    if (barra && /^[ \t]*\/\*/.test(linha)) resto = linha.replace(/^[ \t]*(?:\/\*.*?\*\/[ \t]*)+/, '');
    if (aspaSemPar(resto)) seguro = false;
    return resto;
  });
  return seguro ? linhas.join('\n') : text;
}

/**
 * Forma de NOME DE FUNÇÃO aceita para a isenção de chamada, por segmento do
 * nome pontuado (`contexto.token_interno`): curto (≤ 11, abaixo do mínimo de 12
 * da regra), snake_case, camelCase ou PascalCase. Um literal só de letras como
 * `abcdefghijklmnopqrstuv` não tem nenhuma dessas formas (rodada 2, item 2).
 */
const SEGMENTO_DE_NOME =
  /^(?:[A-Za-z_$][\w$]{0,10}|_*[a-z]+(?:_[a-z]+)+|_*[a-z]+(?:[A-Z][a-z]+)+|[A-Z][a-z]+(?:[A-Z][a-z]+)+)$/;

function nomeDeFuncao(nome: string): boolean {
  return !/\d/.test(nome) && nome.split('.').every((seg) => SEGMENTO_DE_NOME.test(seg));
}

/**
 * `token = contexto.token_interno()` não é valor constante. Só neutraliza
 * quando TODAS valem (rodada 2 da review — na dúvida, marca):
 *  - o nome chamado tem forma de identificador (`nomeDeFuncao`), sem dígito;
 *  - o resto da linha depois do `(` não tem NENHUMA aspa — cobre `"…"`, `b"…"`,
 *    `r"…"`, `f"…"`, `"""…"""` e também `f() or "abc…"`;
 *  - o `)` fecha na mesma linha e ela não termina em `\` (sem continuação —
 *    argumento na linha de baixo nunca é isento).
 */
function neutralizaChamada(text: string): string {
  return text
    .split('\n')
    .map((linha) =>
      linha.replace(
        /([:=][ \t]*(?:await[ \t]+)?)([A-Za-z_$][\w$.]*)\(/g,
        (m, pre: string, nome: string, pos: number) => {
          const resto = linha.slice(pos + m.length);
          const isenta =
            nomeDeFuncao(nome) &&
            !/["'`]/.test(resto) &&
            resto.includes(')') &&
            !/\\[ \t]*$/.test(resto);
          return isenta ? `${pre}CHAMADA(` : m;
        },
      ),
    )
    .join('\n');
}

/**
 * Identidade que o `slug:` tem de casar, a partir do caminho do artefato.
 *
 * O repositório de clientes tem DOIS formatos (issue#2500):
 *
 *   arquivo único  `orgs/<org>/agentes/ana.yaml`            → o ARQUIVO é o slug
 *   pacote         `orgs/<org>/tools/<slug>/manifest.yaml`    → a PASTA é o slug
 *
 * No pacote o arquivo se chama SEMPRE `manifest.yaml`, então comparar com o
 * nome do arquivo era regra impossível de satisfazer: o `adk validate`
 * reprovava 9 de 9 pacotes num repositório real (issue#2594) enquanto o
 * `adk deploy` aceitava os mesmos arquivos — e um gate que discorda do servidor
 * ensina o time a ignorá-lo.
 *
 * `null` = não dá para saber (um `manifest.yaml` solto, que é como o
 * `adk build` chama esta função): melhor calar do que inventar "manifest" como
 * identidade esperada.
 */
function identidadeEsperada(filename: string): string | null {
  const partes = filename.split('/').filter(Boolean);
  const arquivo = partes[partes.length - 1] ?? filename;
  if (/^manifest\.ya?ml$/.test(arquivo)) return partes[partes.length - 2] ?? null;
  return arquivo.replace(/\.ya?ml$/, '');
}

export function scanLeaks(text: string, options: ScanLeaksOptions): SpecIssue[] {
  const issues: SpecIssue[] = [];

  // issue#2817 — LER de variável de ambiente é o jeito CERTO de não versionar
  // segredo, e a regra reprovava justamente isso: o lado direito exige 12+
  // caracteres de `[A-Za-z0-9_.-]`, e `os.environ.get` tem 14. O gate acusava
  // `secret = os.environ.get("X")`, e o contorno natural — renomear a variável
  // — ensina a próxima pessoa que a prática correta não passa no portão.
  //
  // Neutralizar a chamada ANTES de procurar (mesmo desenho do digest da imagem,
  // issue#2603, duas regras abaixo) em vez de pôr um lookahead no fim do
  // quantificador: `{12,}` é guloso e o motor faria backtrack até um recorte
  // de 12 caracteres que satisfizesse o lookahead — a defesa pareceria pronta
  // e não seria. O que o gate quer pegar é `token = "abc123…"`, nunca
  // `token = leia_de_algum_lugar()`.
  const semLeituraDeEnv = text.replace(
    /os\.environ\.get|os\.getenv|process\.env\.[A-Za-z_]\w*|process\.env\[|Deno\.env\.get|System\.getenv/g,
    'ENV',
  );

  // issue#2853 — duas isenções da regra de ATRIBUIÇÃO, mesmo desenho do
  // neutralizador de env acima (trocar o trecho ANTES de procurar, nunca
  // lookahead depois do `{12,}` guloso):
  //   1. `token = contexto.token_interno()` — atribuir a partir de uma CHAMADA
  //      não é valor constante no arquivo, e é o padrão que a plataforma quer
  //      incentivar (pedir a credencial ao Hub). `await f()` idem.
  //   2. linha INTEIRA de comentário (`#`, `//`, `/*`) — o comentário que explica
  //      o falso positivo citando a linha disparava o mesmo falso positivo.
  // Segredo de verdade num comentário continua pego pelo FORMATO (`sk-…`, JWT,
  // chave privada), que não usa este texto.
  const semChamadaNemComentario = neutralizaChamada(
    neutralizaComentario(semLeituraDeEnv, options.filename),
  );

  for (const regra of SEGREDO) {
    const alvo = regra.ignoraComentarioEChamada ? semChamadaNemComentario : semLeituraDeEnv;
    const achado = regra.re.exec(alvo);
    if (!achado) continue;
    issues.push({
      code: regra.code,
      path: regra.chave ? achado[regra.chave] : options.filename,
      message: regra.mensagem(regra.oque),
    });
  }

  // PII continua valendo em TODO arquivo, inclusive de teste: `tests/` sobe ao
  // Hub junto com o bundle (bundle.ts PREFIXOS_PERMITIDOS) e fica gravado no
  // servidor. Isentar telefone sintético em teste (issue#2817, item 2) é
  // decisão do PO, ainda não registrada — por isso não está aqui.
  for (const regra of PII) {
    const achado = regra.re.exec(text);
    if (!achado) continue;
    issues.push({
      code: regra.code,
      path: regra.chave ? achado[regra.chave] : options.filename,
      message: regra.mensagem(regra.oque),
    });
  }

  // issue#2808 — `turn_context` só acusa o nome como CHAVE COM VALOR ao lado,
  // não a mera MENÇÃO. `text.includes(c)` reprovava também o placeholder
  // `<oap_contact_phone>` — que é exatamente como se documenta a interface do
  // turno para o modelo num prompt (bloqueava o prompt real de um cliente).
  // A regex exige uma das três formas já tratadas no resto deste arquivo —
  // `nome: valor` (YAML), `nome = valor`, `"nome": "valor"` (JSON) — herdando
  // o `["']?` de paridade YAML/JSON e o lookbehind `(?<![\w-])` da regra de
  // segredo. O `(?!...)` na frente do valor isenta placeholder mesmo quando
  // ele está do LADO DO VALOR (`oap_contact_phone: <oap_contact_phone>` não
  // tem dado pessoal ali), com ou sem aspas (`"<x>"`, `{"nome":"{{x}}"}`): a
  // aspa opcional fica DENTRO do lookahead, senão o motor faz backtrack,
  // casa o `["']?` vazio e o `\S` pega a própria aspa. Nome em prosa sem valor ao lado passa — é
  // alargamento deliberado da semântica, de "menção" para "menção com valor".
  for (const c of CONTEXTO_DE_TURNO) {
    const re = new RegExp(`(?<![\\w-])${c}["']?\\s*[:=]\\s*(?!["']?(?:<|\\{\\{|\\$\\{))["']?\\S`);
    if (re.test(text)) {
      issues.push({
        code: 'turn_context',
        path: c,
        message: `"${c}" é contexto do turno, não configuração do agente`,
      });
    }
  }

  // issue#2603 — o digest da imagem NÃO é identificador interno; é o oposto.
  // `kind: mcp` é OBRIGADO a declarar `image: …@sha256:<64 hex>` (tag é
  // recusada), e um digest que comece com `c` casa `c[a-z0-9]{24,}`. Isso
  // reprovava ~1 em 16 imagens, sorteado pelo CONTEÚDO: um rebuild podia
  // quebrar um manifesto que passava, sem ninguém ter mexido nele. Retirar o
  // digest antes de procurar mantém a regra viva para o resto do arquivo.
  const semDigest = text.replace(/sha256:[0-9a-f]{64}/g, 'sha256:<digest>');

  if (ID_INTERNO.test(semDigest)) {
    issues.push({
      code: 'internal_id',
      path: options.filename,
      message:
        'identificador interno — use o nome legível, senão o arquivo só vale no ambiente de origem',
    });
  }

  if (options.checkSlug !== false) {
    const slug = text.match(/^slug:\s*(\S+)/m)?.[1];
    const esperado = identidadeEsperada(options.filename);
    if (slug !== undefined && esperado !== null && slug !== esperado) {
      issues.push({
        code: 'slug_filename_mismatch',
        path: 'slug',
        message: `slug "${slug}" não casa com o arquivo "${esperado}" — o apply subiria outra identidade`,
      });
    }
  }

  return issues;
}

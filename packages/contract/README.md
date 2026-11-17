# @simpla.fy/adk-contract

Funções **puras** (sem Prisma, Nest, filesystem ou rede) que definem o contrato
de especificação do ADK. É o mesmo motor dos dois lados da fronteira: o que o
`adk build` reprova é o que o `POST /api/v1/adk/*/apply` reprova, com o mesmo
`code` e o mesmo `path`.

## Exporta

- `SPEC_VERSION` (`'v1'`), `SUPPORTED_SPEC_VERSIONS` (janela N / N-1), `SPEC_KINDS`.
- `SpecIssue { code: SpecIssueCode, path, message }` — `SpecIssueCode` é **união
  fechada**: código inventado de um lado só apareceria quando alguém comparasse
  os dois.
- Portão 1: `validateSpecStructure` / `validateSpecStructureAs` (agent, tool, journey).
  Códigos de vínculo agente↔tool (hub#2.6.21.11): `invalid_tool_binding`,
  `reserved_tool_name`, `duplicate_tool_binding`.
- Portão 2: `validateActivation`, `findCompositionCycle`, `compositionEdgesAfterApply`.
- `scanLeaks(text, { filename })` — segredo, PII, id interno, contexto de turno e
  identidade que não casa com o arquivo (`secret_literal`, `pii_in_config`,
  `internal_id`, `turn_context`, `slug_filename_mismatch`). `turn_context`
  (issue#2808) só acusa o nome como CHAVE COM VALOR ao lado — placeholder
  (`<nome>`, `{{nome}}`, `${nome}`) não reprova.
- `toSlug`, `resolveReference`, `parseSpecYaml` / `serializeSpecYaml` (`KEY_ORDER`).
- `PolicySchema`, `DEFAULT_POLICY`, `checkAgainstPolicy`.
- Tipos e schemas zod: `AgentSpec`, `ToolSpec`, `JourneySpec`, `ToolContract`.
- **Time** (`kind: team`, ADR-290): `team.yaml` na raiz do pacote. `TeamSpecSchema`
  (amplo ou especialista; os mesmos nomes de campo, em português, do manifesto do Hub),
  `validateTeamSpecStructure` (também por `validateSpecStructure`/`validateSpecStructureAs('team', …)`)
  e `resolverTime(amplo, especialista?)`, que devolve o time final (soma, `naoHerda`,
  `promptAcrescimo`) ou o primeiro erro. Cada peça é `call:` (chamada ao MCP completo:
  `ferramenta`, `argumentos`, `desfazer`, `desfazerArgumentos`/`semDesfazer`) **ou** `spec:`
  (`kind` + `arquivo` de um tipo declarativo do ADK), nunca as duas. Códigos novos:
  `duplicate_team_key`, `invalid_team_piece`, `invalid_piece_reference`, `undo_reason_missing`,
  `released_team_with_em_breve`, `team_without_principal`, `agent_piece_without_member`,
  `unknown_team_piece`, `invalid_team_inheritance`. O que este pacote **não** julga: que a
  `ferramenta` de uma peça `call` existe no catálogo do MCP completo (só o servidor tem o
  catálogo) e `requisitos` (o Hub calcula). Nenhum texto de time real vai no tarball.
- `journeyFlowToGraph`, `statusInicialDaJornada` (dialeto do arquivo → grafo do
  canvas; jornada criada pelo apply nunca nasce ativa).

O tarball leva só `dist/` e o README: as fixtures golden ficam em
`test/fixtures/` (fora do pacote) e são sintéticas — configuração real de
cliente não entra em pacote público. Veja `test/fixtures/README.md`.

## Portes

O código veio de `apps/api/src/adk/{spec-gates,reference-resolver,agent-yaml,
agent-fields,agent-export}.ts` e `apps/api/src/tool-registry/tool-contract.ts`
(hub-v2, `origin/staging`), e de `scripts/validar.mjs` (simplafy-clientes,
`origin/main`). **Mensagens e `path` são byte a byte os do original** — mudá-los
quebraria o mutation check dos dois lados.

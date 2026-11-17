# test/fixtures/

Golden dos validadores — **fora do tarball publicado** (`files` do
`package.json` não lista esta pasta) e **sintético**.

- `jornada-exemplo-360.yaml`: mesma FORMA da fixture de jornada do hub-v2
  (`apps/api/src/adk/fixtures/`), com nomes de template, pipeline e slug
  sintéticos. A fixture original é configuração real de um cliente em produção:
  dado de cliente não entra em pacote público do npm, e a forma é o que o teste
  precisa exercitar — não os nomes.
- `agent-contract.json`: contrato do `kind: agent` (Hub#2.6.21.83) — classificação
  dos campos (`field_groups`), valores válidos/inválidos dos campos de definição,
  Alcance por vínculo de tool (ADR-206) e `agent_control.areas`, com os códigos de
  erro esperados. Replicado **verbatim** do hub-v2
  (`apps/api/src/adk/fixtures/agent-contract.json`): os dois repositórios testam
  contra o mesmo arquivo, e mudança de um lado só tem de quebrar o outro.
  Sintético, sem dado de cliente.
- `mcp-servers-contract.json`: **removido**. O arquivo é replicado byte a byte
  entre hub-v2 (`apps/api/src/tool-registry/fixtures/`) e simplafy-ia
  (`tests/fixtures/`); uma terceira cópia aqui não tinha consumidor nem teste
  (só divergiria em silêncio), e sanitizá-la destruiria justamente a identidade
  byte a byte que faz dela um golden. A convergência é os dois repositórios
  passarem a consumir este pacote (parte 2 / N10).

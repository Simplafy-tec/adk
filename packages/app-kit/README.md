# @simpla.fy/app-kit

Kit **público** para construir apps do Hub da Simplafy. Sem token, sem registro privado:

```sh
npm i @simpla.fy/app-kit
```

O caminho normal é começar pelo esqueleto, não pelo pacote:

```sh
npm init @simpla.fy/app meu-app   # ou: adk init app meu-app
cd meu-app && npm install
adk dev                            # Vite (HMR) + Hub shell local em 127.0.0.1
```

## O que vem

| Export                                                                    | O que é                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `tokens.css` (`@simpla.fy/app-kit/tokens.css`)                         | Tokens do design system: `--color-*`, `--font-*`, `--radius-*`, claro e escuro |
| `simplafyAppPreset` (`@simpla.fy/app-kit/tailwind-preset`)             | Preset Tailwind com a mesma paleta                                             |
| `Button`, `Badge`, `Input`, `Select`, `Switch`, `Card`, `Dialog`, `Toast` | Componentes base                                                               |
| `<Brand/>`                                                                | O **único** ponto de logo da Simplafy                                          |
| `useHost()`                                                               | Lado app da ponte: `toast`, `dialog`, `navigate`, `theme`                      |
| `HostShell`                                                               | Lado host: embute o app em `<iframe>` e renderiza o que ele pediu              |
| `applyTheme`, `color`, `font`, `radius`                                   | Utilitários de tema e token                                                    |

Storybook público com todos os componentes: `pnpm build-storybook`.

## Regras de aderência

O `adk build` (e o apply do Hub, com a MESMA função) reprovam com o código
`ui_adherence`:

- **cor literal** — `#22c55e`, `rgb(...)`, `oklch(...)` no seu código. Use `var(--color-*)`.
- **fonte fora do token** — `font-family: "Comic Sans MS"`. Use `var(--font-sans)`.
- **logo fora de `<Brand/>`** — `<img>`/SVG de marca solto.

## A ponte

O app roda num `<iframe>`. Toda troca com o Hub é um envelope versionado
`{ v: 1, type, payload }`, validado por zod **dos dois lados**, com a origem
conferida por allowlist exata. Mensagem fora do contrato é descartada em
silêncio — nunca lança.

Nada de **autoridade** trafega aqui: organização, usuária, papel e token vêm do
servidor para o host, jamais de um `postMessage`.

## Fronteira

Este pacote **não** contém componente exclusivo do produto (estúdio de agente,
console de BI, inbox, jornada) nem depende de `@simplafy-tec/ui`. A auditoria do
tarball roda no CI.

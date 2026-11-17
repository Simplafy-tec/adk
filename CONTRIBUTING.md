# Como contribuir

Obrigado por querer melhorar o ADK da Simplafy. Este repositório tem o contrato de especificação (`@simpla.fy/adk-contract`), a CLI (`@simpla.fy/adk`), o app-kit (`@simpla.fy/app-kit`) e o criador de projetos (`@simpla.fy/create-app`).

## Antes de abrir um PR

1. Abra uma issue descrevendo o problema ou a ideia, para combinarmos o caminho antes do código.
2. Faça um fork, crie um branch a partir da `main` e mantenha o PR pequeno e com um assunto só.
3. Use [Conventional Commits](https://www.conventionalcommits.org/pt-br/) nas mensagens (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).

## Ambiente

- Node.js 20 ou superior e [pnpm](https://pnpm.io/).
- `pnpm install --frozen-lockfile` — nunca apague nem regenere o `pnpm-lock.yaml` sem motivo; mudança de dependência precisa de justificativa no PR.
- `pnpm build && pnpm lint && pnpm typecheck && pnpm test` antes de pedir revisão.

## O que esperamos de um PR

- Teste que falha sem a mudança e passa com ela.
- Nada de segredo, token ou dado real de pessoa ou empresa em código, teste ou exemplo — use `acme`, `Ana`, `+55 11 99999-9999` e afins.
- Textos visíveis ao usuário em português do Brasil.

## Revisão e CI

O CI de PRs vindos de fork só roda depois que uma pessoa da Simplafy aprova a execução. Um mantenedor revisa, pode pedir ajustes e faz o merge. A publicação no npm é feita só pela Simplafy, a partir de tag.

## Licença

Ao contribuir, você concorda que sua contribuição será licenciada sob a [Licença MIT](LICENSE) deste repositório.

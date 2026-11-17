import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/storybook-static/**',
      'packages/cli/templates/**',
      // plugin/ não entra no workspace TS (N21) — script de hook roda em
      // Node puro fora deste projeto ESLint.
      'plugin/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // O contrato usa `unknown` + narrowing; `any` explícito é erro de verdade.
      '@typescript-eslint/no-explicit-any': 'error',
      // `ignoreRestSiblings`: `const { campo, ...resto } = obj` é a forma idiomática
      // de OMITIR um campo — o descarte é o objetivo, não um esquecimento.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    // Teste é contrato: sobra de import não pode reprovar o CI de quem
    // implementa. Continua visível como aviso.
    files: ['**/test/**/*.ts'],
    rules: { '@typescript-eslint/no-unused-vars': 'warn' },
  },
);

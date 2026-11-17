import type { StorybookConfig } from '@storybook/react-vite';
import tailwindcss from '@tailwindcss/vite';

/**
 * Mesmo molde do Storybook do `simplafy-ui` (Storybook 8 + react-vite +
 * `@tailwindcss/vite`): duas configurações diferentes de design system na casa
 * é a origem de "no Storybook está certo, no app não".
 *
 * Este aqui é PÚBLICO — só lista o que o pacote exporta.
 */
const config: StorybookConfig = {
  stories: ['../stories/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-essentials'],
  framework: { name: '@storybook/react-vite', options: {} },
  docs: { autodocs: 'tag' },
  viteFinal(config) {
    config.plugins = config.plugins ?? [];
    config.plugins.push(tailwindcss());
    return config;
  },
};

export default config;

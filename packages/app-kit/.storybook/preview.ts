import type { Preview } from '@storybook/react';
import './storybook.css';

const preview: Preview = {
  parameters: {
    layout: 'centered',
    controls: { matchers: { color: /(background|color)$/i } },
  },
  globalTypes: {
    theme: {
      description: 'Tema do design system (classe .dark no elemento raiz)',
      defaultValue: 'light',
      toolbar: {
        title: 'Tema',
        items: [
          { value: 'light', title: 'Claro' },
          { value: 'dark', title: 'Escuro' },
        ],
      },
    },
  },
  decorators: [
    (Story, contexto) => {
      // A prova viva do GATE 4: trocar o tema no toolbar troca a CLASSE, e os
      // tokens recalculam sem rebuild — igual ao que a ponte faz no Hub.
      document.documentElement.classList.toggle('dark', contexto.globals.theme === 'dark');
      return Story();
    },
  ],
};

export default preview;

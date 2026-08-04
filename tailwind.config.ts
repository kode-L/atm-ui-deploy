import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        accent: { DEFAULT: '#f0b90b', dark: '#c99a09', light: '#fcd535' },
        surface: { DEFAULT: '#0b0e11', primary: '#0b0e11', secondary: '#1e2329', tertiary: '#2b3139' },
        txt: { primary: '#eaecef', secondary: '#9aa4b0' },
      },
    },
  },
  plugins: [],
};
export default config;

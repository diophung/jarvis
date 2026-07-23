/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Warm copper accent — calm, Claude-inspired
        jarvis: {
          50: '#fdf6f3',
          100: '#fbeae3',
          200: '#f6d2c2',
          300: '#efb198',
          400: '#e58762',
          500: '#d96f47',
          600: '#c2552e',
          700: '#a14425',
          800: '#843a23',
          900: '#6d3220',
        },
        surface: {
          DEFAULT: '#faf9f7',
          raised: '#ffffff',
          sunken: '#f3f1ee',
          border: '#e7e3dd',
        },
        ink: {
          DEFAULT: '#1f1d1a',
          muted: '#6b6258',
          faint: '#9b9288',
        },
      },
      fontFamily: {
        sans: [
          'ui-sans-serif',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
      },
      maxWidth: {
        chat: '48rem',
      },
    },
  },
  plugins: [],
};

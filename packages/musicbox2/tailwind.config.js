/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        stem: {
          drums: '#f59e0b',
          bass: '#a78bfa',
          vocals: '#f472b6',
          other: '#34d399',
        },
      },
    },
  },
  plugins: [],
};

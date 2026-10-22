import colors from 'tailwindcss/colors'

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./client/index.html', './client/src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        brand: colors.teal, // primary
        sky: colors.sky, // soft blue tints
        accent: colors.amber, // the one accent colour
        ink: { DEFAULT: '#12303a', soft: '#3f5b66', muted: '#5b7480' }
      },
      fontFamily: { sans: ['"Inter Variable"', 'Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'] },
      boxShadow: { card: '0 1px 2px rgba(18,48,58,.05), 0 8px 24px -12px rgba(18,48,58,.12)' },
      keyframes: {
        'fade-up': { '0%': { opacity: 0, transform: 'translateY(8px)' }, '100%': { opacity: 1, transform: 'none' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } }
      },
      animation: { 'fade-up': 'fade-up .35s ease-out both' }
    }
  },
  plugins: []
}

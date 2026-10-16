/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        void: '#030304',
        surface: '#0F1115',
        stardust: '#94A3B8',
        dim: '#1E293B',
        btc: {
          DEFAULT: '#F7931A',
          burn: '#EA580C',
          gold: '#FFD600',
        },
      },
      fontFamily: {
        heading: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        body: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      maxWidth: {
        shell: '80rem',
      },
      boxShadow: {
        glow: '0 0 20px -5px rgba(234, 88, 12, 0.5)',
        'glow-lg': '0 0 30px -5px rgba(247, 147, 26, 0.6)',
        'glow-soft': '0 0 50px -10px rgba(247, 147, 26, 0.12)',
        gold: '0 0 20px rgba(255, 214, 0, 0.3)',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-12px)' },
        },
        'pulse-dot': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.45', transform: 'scale(0.85)' },
        },
      },
      animation: {
        float: 'float 8s ease-in-out infinite',
        'pulse-dot': 'pulse-dot 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

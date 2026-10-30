import type { Config } from 'tailwindcss'
import animate from 'tailwindcss-animate'
import typography from '@tailwindcss/typography'

export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '1.5rem', screens: { '2xl': '1440px' } },
    extend: {
      colors: {
        border: 'hsl(var(--border) / <alpha-value>)',
        input: 'hsl(var(--input) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        primary: { DEFAULT: 'hsl(var(--primary) / <alpha-value>)', foreground: 'hsl(var(--primary-foreground) / <alpha-value>)' },
        secondary: { DEFAULT: 'hsl(var(--secondary) / <alpha-value>)', foreground: 'hsl(var(--secondary-foreground) / <alpha-value>)' },
        muted: { DEFAULT: 'hsl(var(--muted) / <alpha-value>)', foreground: 'hsl(var(--muted-foreground) / <alpha-value>)' },
        accent: { DEFAULT: 'hsl(var(--accent) / <alpha-value>)', foreground: 'hsl(var(--accent-foreground) / <alpha-value>)' },
        destructive: { DEFAULT: 'hsl(var(--destructive) / <alpha-value>)', foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)' },
        success: { DEFAULT: 'hsl(var(--success) / <alpha-value>)', foreground: 'hsl(var(--success-foreground) / <alpha-value>)' },
        warning: { DEFAULT: 'hsl(var(--warning) / <alpha-value>)', foreground: 'hsl(var(--warning-foreground) / <alpha-value>)' },
        info: { DEFAULT: 'hsl(var(--info) / <alpha-value>)', foreground: 'hsl(var(--info-foreground) / <alpha-value>)' },
        card: { DEFAULT: 'hsl(var(--card) / <alpha-value>)', foreground: 'hsl(var(--card-foreground) / <alpha-value>)' },
        popover: { DEFAULT: 'hsl(var(--popover) / <alpha-value>)', foreground: 'hsl(var(--popover-foreground) / <alpha-value>)' },
        sidebar: 'hsl(var(--sidebar) / <alpha-value>)',
        grad: { from: 'hsl(var(--grad-from) / <alpha-value>)', to: 'hsl(var(--grad-to) / <alpha-value>)' },
        diff: {
          add: 'hsl(var(--diff-add) / <alpha-value>)',
          del: 'hsl(var(--diff-del) / <alpha-value>)',
          mod: 'hsl(var(--diff-mod) / <alpha-value>)',
        },
      },
      borderRadius: {
        xl: 'calc(var(--radius) + 4px)',
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 4px)',
        sm: 'calc(var(--radius) - 8px)',
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      fontSize: {
        '2xs': ['10.5px', { lineHeight: '14px', letterSpacing: '0.04em' }],
      },
      boxShadow: {
        panel: '0 1px 0 0 hsl(var(--foreground) / 0.04) inset, 0 24px 60px -30px rgba(0,0,0,0.65)',
        glow: '0 0 0 1px hsl(var(--primary) / 0.25), 0 8px 32px -8px hsl(var(--primary) / 0.55)',
        float: '0 20px 60px -20px rgba(0,0,0,0.7), 0 0 0 1px hsl(var(--border) / 0.8)',
      },
      backgroundImage: {
        'accent-grad': 'linear-gradient(135deg, hsl(var(--grad-from)) 0%, hsl(var(--grad-to)) 100%)',
        'panel-grad': 'linear-gradient(180deg, hsl(var(--card) / 0.9) 0%, hsl(var(--card) / 0.6) 100%)',
        'grid-faint': 'linear-gradient(to right, hsl(var(--foreground) / 0.045) 1px, transparent 1px), linear-gradient(to bottom, hsl(var(--foreground) / 0.045) 1px, transparent 1px)',
      },
      backgroundSize: { grid: '32px 32px' },
      keyframes: {
        'fade-up': { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        float: { '0%,100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-6px)' } },
        drift: { '0%': { transform: 'translate3d(0,0,0) scale(1)' }, '50%': { transform: 'translate3d(3%, -2%, 0) scale(1.06)' }, '100%': { transform: 'translate3d(0,0,0) scale(1)' } },
        'pulse-ring': { '0%': { boxShadow: '0 0 0 0 hsl(var(--primary) / 0.5)' }, '70%': { boxShadow: '0 0 0 10px hsl(var(--primary) / 0)' }, '100%': { boxShadow: '0 0 0 0 hsl(var(--primary) / 0)' } },
        'caret-blink': { '0%,70%,100%': { opacity: '1' }, '20%,50%': { opacity: '0' } },
      },
      animation: {
        'fade-up': 'fade-up .35s cubic-bezier(.2,.7,.3,1) both',
        'fade-in': 'fade-in .3s ease both',
        shimmer: 'shimmer 2s infinite',
        float: 'float 6s ease-in-out infinite',
        drift: 'drift 24s ease-in-out infinite',
        'pulse-ring': 'pulse-ring 2s cubic-bezier(.4,0,.6,1) infinite',
        'caret-blink': 'caret-blink 1.2s steps(1) infinite',
      },
      transitionTimingFunction: { spring: 'cubic-bezier(.2,.8,.2,1)' },
    },
  },
  plugins: [animate, typography],
} satisfies Config

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx}', './index.html'],
  theme: {
    extend: {
      colors: {
        // 低刺激深色系：偏灰蓝，不用纯黑
        ink: {
          900: '#14161A',
          800: '#1B1E24',
          700: '#232730',
          600: '#2C313C',
          500: '#3A404E',
        },
        mist: {
          DEFAULT: '#C9CFDA',
          dim: '#8B93A3',
          faint: '#5C6373',
        },
        calm: {
          DEFAULT: '#7FA6B8', // 低饱和青蓝，主强调色
          soft: '#A7C4D0',
        },
        moss: '#8FAF8A', // 完成态，低饱和绿
      },
      borderRadius: {
        xl2: '14px',
      },
      fontSize: {
        // 大字号可读性
        base2: ['15px', '22px'],
        lg2: ['18px', '26px'],
      },
    },
  },
  plugins: [],
};
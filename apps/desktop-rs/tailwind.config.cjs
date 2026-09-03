/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx}', './index.html'],
  theme: {
    extend: {
      colors: {
        // 「暖砂」主题 —— 温暖低刺激浅色，灵感来自掌印肉垫与陪伴的柔软
        sand: {
          DEFAULT: '#F2EDE3', // 页面背景 · 暖砂米
        },
        surface: {
          DEFAULT: '#FBF8F2', // 卡片表面 · 暖近白
          2: '#E9E2D5',       // 次级表面 / 悬停 / 轨道
        },
        line: '#E2DACB',      // 分隔线
        ink: {
          DEFAULT: '#2C2722', // 主文字 · 深暖棕
          dim: '#6B635A',     // 次要文字
          faint: '#A2998B',   // 弱文字 / 占位
        },
        accent: {
          DEFAULT: '#C1753C', // 强调 · 暖杏橙
          deep: '#A8622F',
          soft: '#EAD2B8',    // 浅强调（徽标底 / hover 底）
        },
        paw: '#D18E7C',       // 签名色 · 肉垫粉
        positive: '#74915C',  // 完成态 · 橄榄绿
      },
      borderRadius: {
        xl2: '14px',
      },
      fontSize: {
        base2: ['15px', '22px'],
        lg2: ['18px', '26px'],
        display: ['44px', '52px'], // 大数字 hero
      },
      fontFamily: {
        sans: [
          '"Segoe UI Variable"',
          '"Segoe UI"',
          '"Microsoft YaHei UI"',
          '"Microsoft YaHei"',
          'system-ui',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
};

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        rose:    { DEFAULT: "#e07a5f", light: "#fdf0ec", dark: "#c45f44" },
        sage:    { DEFAULT: "#81b29a", light: "#eef5f1", dark: "#5f8f7a" },
        cream:   { DEFAULT: "#fdf8f5" },
        ink:     { DEFAULT: "#2d2d2d" },
        muted:   { DEFAULT: "#9a8f8f" },
      },
      fontFamily: {
        serif:  ["var(--font-serif)", "Georgia", "Cambria", "serif"],
        sans:   ["var(--font-sans)", "Inter", "system-ui", "sans-serif"],
      },
      borderRadius: { "2xl": "1rem", "3xl": "1.5rem" },
      boxShadow: {
        soft: "0 1px 2px rgba(45,45,45,0.04), 0 8px 24px -12px rgba(45,45,45,0.12)",
        lift: "0 4px 10px rgba(45,45,45,0.06), 0 16px 32px -16px rgba(224,122,95,0.18)",
      },
    },
  },
  plugins: [],
};

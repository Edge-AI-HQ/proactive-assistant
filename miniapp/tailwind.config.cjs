/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      boxShadow: {
        panel: "0 18px 42px rgba(13, 21, 35, 0.1)",
      },
      fontFamily: {
        heading: ["Lexend", "ui-sans-serif", "sans-serif"],
        body: ["Plus Jakarta Sans", "ui-sans-serif", "sans-serif"],
      },
      colors: {
        sand: "#f9f4ef",
        ink: "#16202a",
        muted: "#516072",
        primary: "#eb4a27",
        accent: "#1f7a79",
      },
    },
  },
  plugins: [],
};

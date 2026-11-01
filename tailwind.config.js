/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    // The whole radius scale; a class outside it renders square. By size, so
    // that like controls match and a corner nested in another stays concentric
    // (inner = outer minus the padding between them):
    //   rounded       small things under 28px: tags, tiny buttons, menu rows, segments in a track
    //   rounded-lg    controls and blocks: buttons, inputs, tabs, menus, inline notes
    //   rounded-xl    surfaces: cards, dialogs, popovers
    //   rounded-full  what is meant to be round: dots, switches, count badges, progress bars
    borderRadius: {
      DEFAULT: "0.25rem",
      lg: "0.5rem",
      xl: "0.75rem",
      full: "9999px",
    },
    extend: {
      colors: {
        background: "var(--background)",
        surface: "#09090b",   
        panel: "#121214",     
        primary: "rgb(var(--primary) / <alpha-value>)",
        border: "var(--border)",    
        muted: "#a1a1aa",
      },
      // Tailwind's spin and pulse, but they stop: 12 turns, 5 pulses. For
      // states that can last (a tab connecting or waiting for an answer, a
      // retry, broadcast on): the browser draws an endless animation at every
      // frame, and a tab left waiting kept 13-29% of a CPU core busy for a
      // dot and a spinner that had nothing new to say.
      animation: {
        "spin-brief": "spin 1s linear 12",
        "pulse-brief": "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) 5",
      },
    },
  },
  plugins: [],
}
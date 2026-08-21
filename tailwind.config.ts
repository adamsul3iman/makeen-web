import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
    "./hooks/**/*.{ts,tsx}",
    "./services/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: "var(--pos-primary)",
        "primary-hover": "var(--pos-primary-hover)",
        "primary-foreground": "var(--pos-primary-foreground)",
        success: "var(--pos-success)",
        "success-hover": "var(--pos-success-hover)",
        "success-foreground": "var(--pos-success-foreground)",
        destructive: "var(--pos-destructive)",
        "destructive-hover": "var(--pos-destructive-hover)",
        "destructive-foreground": "var(--pos-destructive-foreground)",
        background: "var(--pos-background)",
        surface: "var(--pos-surface)",
        "surface-muted": "var(--pos-surface-muted)",
        border: "var(--pos-border)",
        foreground: "var(--pos-foreground)",
        muted: "var(--pos-muted)",
        "muted-foreground": "var(--pos-muted-foreground)",
      },
    },
  },
  plugins: [],
};

export default config;

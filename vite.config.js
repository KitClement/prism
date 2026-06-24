import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Served from the prismstat.com root via GitHub Pages (custom domain),
  // so assets resolve from "/".
  base: "/",
  plugins: [react()],
});

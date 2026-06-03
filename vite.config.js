import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Served from https://<user>.github.io/tinkersim/ via GitHub Pages,
  // so assets must be referenced under the /tinkersim/ subpath.
  base: "/tinkersim/",
  plugins: [react()],
});

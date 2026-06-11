import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Served from https://<user>.github.io/prism/ via GitHub Pages,
  // so assets must be referenced under the /prism/ subpath.
  base: "/prism/",
  plugins: [react()],
});

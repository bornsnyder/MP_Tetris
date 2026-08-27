import { defineConfig } from "vite";

export default defineConfig({
  root: __dirname,
  base: "/",
  build: {
    outDir: "../dist-client",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    port: 5173,
    proxy: { "/ws": { target: "http://localhost:6000", ws: true } },
  },
});

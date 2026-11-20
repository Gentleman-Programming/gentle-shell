import { defineConfig } from "vite";

// Relative base: /gentle:tower serves dist/ from a random localhost port.
export default defineConfig({
	base: "./",
	build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0, sourcemap: false },
	server: { host: "127.0.0.1" },
});

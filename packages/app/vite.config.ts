import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import { hqBuild } from "./vite.hq.ts"

// `vite dev` sends /api to the running office's TCP listener; add http://localhost:5173 to "dev_origins" in
// office/hq.json once, then restart the office.
const office = `http://127.0.0.1:${process.env.OPENCORP_HQ_PORT ?? 49380}`

export default defineConfig({
  plugins: [solid(), tailwindcss(), hqBuild()],
  server: { port: 5173, strictPort: true, proxy: { "/api": { target: office, changeOrigin: true } } },
  build: {
    // The minimum browsers index.html names.
    target: ["es2022", "chrome116", "safari17.4", "firefox124"],
    // No inline module-preload polyfill: the CSP allows only same-origin script files.
    modulePreload: { polyfill: false },
    // No asset inlined as a data: URL: the CSP's font-src allows only same-origin files.
    assetsInlineLimit: 0,
  },
})

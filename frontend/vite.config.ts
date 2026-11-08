import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

const base = (process.env.SPEC_PUBLIC_BASE_PATH || "/").replace(/\/?$/, "/")
if (!/^\/(?:[A-Za-z0-9_~-][A-Za-z0-9_.~-]*\/)*$/.test(base)) {
  throw new Error("SPEC_PUBLIC_BASE_PATH must be an absolute pathname with safe path segments")
}

export default defineConfig({
  base,
  plugins: [react()],
  server: { proxy: { [`${base}api`]: { target: "http://127.0.0.1:4780", rewrite: (path) => `/${path.slice(base.length)}` } } },
})

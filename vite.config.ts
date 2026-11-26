/// <reference types="node" />

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/topo-studio/' : '/',
  worker: { format: 'es' },
  plugins: [react(), tailwindcss()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: { groups: [{ name: 'three-core', test: /three[\\/]build[\\/]three\.core\.js$/ }] },
      },
    },
  },
})

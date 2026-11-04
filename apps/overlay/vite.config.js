import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// Which notification kinds this build can draw. By default none (everything uses the generic card). A build opts in to
// its own by setting OVERLAY_VIEWS to a module that exports `views` (kind -> view); the overlay never imports a
// specific kind itself.
const viewsModule = process.env.OVERLAY_VIEWS
  ? path.resolve(process.env.OVERLAY_VIEWS)
  : fileURLToPath(new URL('./src/views.default.js', import.meta.url));
if (!fs.existsSync(viewsModule)) {
  throw new Error(`OVERLAY_VIEWS points at a file that does not exist: ${viewsModule}`);
}

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: { 'overlay-views': viewsModule },
    // A views module may live outside this folder; make sure it shares this app's single copy of React.
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 1420,
    strictPort: true,
    // The dev server must be allowed to serve the views module wherever it lives.
    fs: { allow: [repoRoot, path.dirname(viewsModule)] },
  },
});

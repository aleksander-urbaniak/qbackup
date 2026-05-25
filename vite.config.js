import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function monacoChunk(id) {
  if (!id.includes('monaco-editor')) return undefined;
  const normalized = id.replace(/\\/g, '/');

  if (normalized.includes('/esm/vs/basic-languages/')) {
    const language = normalized.split('/esm/vs/basic-languages/')[1]?.split('/')[0];
    return language ? `monaco-lang-${language}` : 'monaco-languages';
  }

  if (normalized.includes('/esm/vs/editor/contrib/')) {
    const contribution = normalized.split('/esm/vs/editor/contrib/')[1]?.split('/')[0];
    return contribution ? `monaco-contrib-${contribution}` : 'monaco-contrib';
  }

  if (normalized.includes('/esm/vs/editor/browser/')) return 'monaco-editor-browser';
  if (normalized.includes('/esm/vs/editor/common/')) return 'monaco-editor-common';
  if (normalized.includes('/esm/vs/base/browser/')) return 'monaco-base-browser';
  if (normalized.includes('/esm/vs/base/common/')) return 'monaco-base-common';

  if (normalized.includes('/esm/vs/platform/')) {
    const service = normalized.split('/esm/vs/platform/')[1]?.split('/')[0];
    return service ? `monaco-platform-${service}` : 'monaco-platform';
  }

  return 'monaco-core';
}

export default defineConfig({
  plugins: [react()],
  build: {
    modulePreload: {
      resolveDependencies(_filename, dependencies) {
        return dependencies.filter((dependency) => !dependency.includes('LiveFilesView') && !dependency.includes('monaco-') && !dependency.includes('editor.worker') && !dependency.includes('codicon-'));
      }
    },
    rollupOptions: {
      output: {
        manualChunks(id) {
          return monacoChunk(id);
        }
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/events': 'http://localhost:8787'
    }
  }
});

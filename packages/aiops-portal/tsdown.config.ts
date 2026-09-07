import { readFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { dirname, resolve } from 'node:path'
import type { UserConfig } from 'tsdown'

const ID = '@deepseek-ai/dsh-aiops-portal'
const CSS_PREFIX = '\0aiops-portal-css:'
const CSS_SUFFIX = '.mjs'
const clientExternal = new Set(['react', 'react/jsx-runtime', '@deepseek-ai/cordis'])

const node: UserConfig = {
  name: ID,
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  target: 'es2024',
  clean: false,
  dts: false,
  sourcemap: true,
  deps: {
    // Rolldown may pass resolved absolute paths here. Only package/builtin
    // boundaries stay external; every package-local module must be inlined
    // because the published Host face is a single lib/index.js artifact.
    neverBundle: specifier => isBuiltin(specifier) || specifier.startsWith('@deepseek-ai/'),
  },
}

const client: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  clean: false,
  dts: false,
  sourcemap: true,
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
  deps: {
    neverBundle: specifier => clientExternal.has(specifier),
    alwaysBundle: specifier => !clientExternal.has(specifier),
  },
  plugins: [{
    name: 'aiops-portal-css-module',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      return CSS_PREFIX + resolve(importer === undefined ? process.cwd() : dirname(importer), source) + CSS_SUFFIX
    },
    async load(id: string) {
      if (!id.startsWith(CSS_PREFIX)) return null
      const file = id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
      this.addWatchFile(file)
      let stylesheet = await readFile(file, 'utf8')
      const classMap: Record<string, string> = {}
      for (const match of stylesheet.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
        const local = match[1]
        if (local !== undefined) classMap[local] = `dsh-aiops-portal-${local}`
      }
      for (const [local, scoped] of Object.entries(classMap)) {
        stylesheet = stylesheet.replaceAll(`.${local}`, `.${scoped}`)
      }
      return [
        `const css = ${JSON.stringify(stylesheet)};`,
        `const classes = ${JSON.stringify(classMap)};`,
        `const tagId = ${JSON.stringify(ID)};`,
        'if (document.querySelector(`style[data-plugin-css="${tagId}"]`) === null) {',
        '  const tag = document.createElement("style");',
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        'export default classes;',
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    sourcemapExcludeSources: false,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [node, client]

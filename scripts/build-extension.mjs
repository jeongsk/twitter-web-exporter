import { build } from 'vite';
import preact from '@preact/preset-vite';
import i18nextLoader from 'vite-plugin-i18next-loader';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import prefixSelector from 'postcss-prefix-selector';
import remToPx from 'postcss-rem-to-pixel-next';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const outDir = resolve(root, 'dist/chrome');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const matches = ['https://x.com/*', 'https://twitter.com/*', 'https://mobile.x.com/*'];

for (const [index, entry] of [
  'app',
  'content',
  'page',
  'popup',
  'background',
  'backup-options',
  'threads-content',
  'youtube-content',
  'youtube-page',
].entries()) {
  await build({
    root,
    configFile: false,
    esbuild: { charset: 'ascii' },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    publicDir: false,
    resolve: {
      alias: [
        { find: /^@\/platform$/, replacement: resolve(root, 'src/extension/platform.ts') },
        { find: '@', replacement: resolve(root, 'src') },
      ],
    },
    plugins: [
      preact(),
      i18nextLoader({ paths: ['./src/i18n/locales'], namespaceResolution: 'basename' }),
    ],
    css: {
      postcss: {
        plugins: [
          tailwindcss(),
          autoprefixer(),
          remToPx({ propList: ['*'] }),
          prefixSelector({ prefix: '#twe-root', exclude: [/^#twe-root/] }),
        ],
      },
    },
    build: {
      outDir,
      emptyOutDir: index === 0,
      target: 'chrome111',
      minify: 'esbuild',
      sourcemap: false,
      lib: {
        entry: resolve(root, `src/extension/${entry}.ts`),
        name: `TwitterExporter_${entry.replaceAll('-', '_')}`,
        formats: [entry === 'app' ? 'es' : 'iife'],
        fileName: () => `${entry}.js`,
        cssFileName: 'app',
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
}
const manifest = {
  manifest_version: 3,
  name: 'Twitter Web Exporter',
  version: pkg.version,
  version_name: `${pkg.version}-chrome.11`,
  description:
    'X 북마크, Threads 저장 게시물, YouTube 좋아요 영상을 수집하고 Obsidian 볼트로 자동 백업합니다.',
  minimum_chrome_version: '111',
  permissions: ['activeTab', 'storage', 'alarms', 'notifications'],
  optional_host_permissions: [
    'https://127.0.0.1/*',
    'https://localhost/*',
    'http://127.0.0.1/*',
    'http://localhost/*',
  ],
  background: { service_worker: 'background.js' },
  options_ui: { page: 'backup.html', open_in_tab: true },
  action: {
    default_title: 'Twitter Web Exporter',
    default_popup: 'popup.html',
    default_icon: { 32: 'icons/icon32.png' },
  },
  icons: { 32: 'icons/icon32.png' },
  content_scripts: [
    { matches, js: ['content.js'], css: ['app.css'], run_at: 'document_start', world: 'ISOLATED' },
    { matches, js: ['page.js'], run_at: 'document_start', world: 'MAIN' },
    {
      matches: [
        'https://www.threads.com/*',
        'https://threads.com/*',
        'https://www.threads.net/*',
        'https://threads.net/*',
      ],
      js: ['threads-content.js'],
      css: ['app.css'],
      run_at: 'document_idle',
      world: 'ISOLATED',
    },
    {
      matches: ['https://www.youtube.com/*', 'https://youtube.com/*', 'https://m.youtube.com/*'],
      js: ['youtube-content.js'],
      run_at: 'document_idle',
      world: 'ISOLATED',
    },
    {
      matches: ['https://www.youtube.com/*', 'https://youtube.com/*', 'https://m.youtube.com/*'],
      js: ['youtube-page.js'],
      run_at: 'document_start',
      world: 'MAIN',
    },
  ],
  web_accessible_resources: [{ resources: ['app.js'], matches }],
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" },
};
await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await cp(resolve(root, 'extension'), outDir, { recursive: true });
await cp(resolve(root, 'LICENSE'), resolve(outDir, 'LICENSE'));
let notices = '# Bundled runtime dependencies\n\n';
for (const name of Object.keys(pkg.dependencies)) {
  const dir = resolve(root, 'node_modules', name);
  const dependency = JSON.parse(await readFile(resolve(dir, 'package.json'), 'utf8'));
  notices += `\n## ${name} ${dependency.version}\nLicense: ${dependency.license ?? 'See source'}\n`;
  for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md']) {
    try {
      notices += '\n' + (await readFile(resolve(dir, file), 'utf8')) + '\n';
      break;
    } catch {
      /* Not every dependency uses the same license filename. */
    }
  }
}
await writeFile(resolve(outDir, 'THIRD_PARTY_NOTICES.txt'), notices);
console.log(`\nChrome extension: ${outDir}`);

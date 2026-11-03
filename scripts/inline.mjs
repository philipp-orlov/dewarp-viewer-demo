#!/usr/bin/env node
// Post-build step: folds what `ng build` emits into dist/dewarp-demo/browser (the JS chunks, the stylesheet) into one
// index.html under dist/dewarp-demo/single/, like gscope's and libsql's single pages. The sample clips are media,
// not code: they stay files, copied to single/samples/ beside the page (the demo streams point at 'samples/<name>').
//
// The normal build splits the JS: a shared chunk, and hls.js as a lazy chunk that only .m3u8 sources load. A single
// file cannot fetch chunks, so the script is bundled again here with esbuild (which @angular/build brings), splitting
// off: the dynamic import of hls.js becomes part of the one script.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const browserDir = join(process.cwd(), 'dist/dewarp-demo/browser');
const outDir = join(process.cwd(), 'dist/dewarp-demo/single');
const outFile = join(outDir, 'index.html');

const MIME_TYPES = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const dataUri = (path) => {
  const type = MIME_TYPES[path.slice(path.lastIndexOf('.'))];
  if (!type) throw new Error(`no MIME type for ${path}`);
  return `data:${type};base64,${readFileSync(join(browserDir, path)).toString('base64')}`;
};

let html = readFileSync(join(browserDir, 'index.html'), 'utf8');

// The <noscript> fallback repeats the stylesheet link; the CSS below is inlined unconditionally.
html = html.replace(/<noscript>.*?<\/noscript>/gs, '');
// Files the stylesheet refers to (none today; fonts or images if they come) become data URIs.
const inlineUrls = (css) => css.replace(/url\("?(\.\/media\/[^")]+)"?\)/g, (match, href) => `url("${dataUri(href)}")`);
html = html.replace(/<style>([\s\S]*?)<\/style>/g, (match, css) => `<style>${inlineUrls(css)}</style>`);
html = html.replace(/<link rel="stylesheet" href="([^"]+)"[^>]*>/g, (match, href) =>
  /^https?:/.test(href) ? match : `<style>${inlineUrls(readFileSync(join(browserDir, href), 'utf8'))}</style>`,
);
// The chunks are folded into the one script below: nothing left to preload.
html = html.replace(/<link rel="modulepreload"[^>]*>/g, '');

// Relative to the page, so that samples/ resolves beside it wherever the folder is served from.
html = html.replace('<base href="/">', '<base href="./">');

const scripts = [];
html = html.replace(/<script src="([^"]+)" type="module"><\/script>/g, (match, src) => {
  scripts.push(src);
  return `<!--script:${src}-->`;
});
for (const src of scripts) {
  const result = await build({
    entryPoints: [join(browserDir, src)],
    bundle: true,
    splitting: false,
    format: 'esm',
    minify: true,
    write: false,
    legalComments: 'none',
    logLevel: 'warning',
  });
  let js = result.outputFiles[0].text;
  // A script may not contain "</script"; in JavaScript "<\/script" means the same text.
  js = js.replace(/<\/script/gi, '<\\/script');
  html = html.replace(`<!--script:${src}-->`, () => `<script type="module">${js}</script>`);
}

const leftover = [...html.matchAll(/(?:src|href)="(?!data:|https?:|#)([^"]+)"/g)].map((m) => m[1]).filter((p) => p !== './');
if (leftover.length) throw new Error(`still refers to files: ${leftover.join(', ')}`);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, html);
cpSync(join(browserDir, 'samples'), join(outDir, 'samples'), { recursive: true });
console.log(`Single-file bundle written to ${outFile} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KiB), the clips in ${join(outDir, 'samples')}`);

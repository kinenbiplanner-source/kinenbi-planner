// @ts-check
import cloudflare from '@astrojs/cloudflare';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  site: 'https://anniv.gift',

  // 末尾スラッシュ無しに統一する。/media/foo と /media/foo/ の両方が 200 を返して
  // 重複扱いされないよう、canonical は必ず BaseHead 側で 1 つに寄せる
  // （メディア方針/計測設計.md と対）。
  trailingSlash: 'never',
  build: { format: 'file' },

  // Cloudflare Workers へ。記事は D1、画像は R2 に置き、/media 配下と /admin・/api は
  // ページ側の `export const prerender = false` でオンデマンドレンダリングにする。
  // LP（public/ 配下の素の HTML）は静的アセットとしてそのまま配信される。
  adapter: cloudflare({
    // ビルド時は sharp で最適化し、実行時は変換しない。
    // Cloudflare Images は有料なので runtime バインディングは使わない。
    imageService: { build: 'compile', runtime: 'passthrough' },
  }),

  // sitemap.xml は D1 の公開記事を含める必要があるため @astrojs/sitemap をやめ、
  // src/pages/sitemap.xml.ts で動的生成する。
});

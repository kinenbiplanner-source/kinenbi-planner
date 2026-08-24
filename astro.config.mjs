// @ts-check
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  site: 'https://anniv.gift',

  // build.format は 'directory'（既定）。'file' にすると出力が media.html になり、
  // Astro.url.pathname も '.html' 付きになるため canonical が
  // 'https://anniv.gift/media.html' として出てしまう。本番は Vercel の cleanUrls で
  // '/media' として配信されるので、canonical と実URLが食い違う。ここは動かさない。
  //
  // trailingSlash は 'ignore'（既定）。/media と /media/ の両方が到達しうるが、
  // canonical を BaseHead 側で「末尾スラッシュ無し」に正規化して1つに寄せている。

  integrations: [
    sitemap({
      // public/ 配下の素の HTML（LP本体・各種ページ）は Astro のページルートではないため
      // 自動収集の対象外。手書き sitemap.xml を廃した代わりにここで明示する。
      // noindex のページ（contact / thanks / links）は載せない。
      customPages: [
        'https://anniv.gift/',
        'https://anniv.gift/privacy.html',
        'https://anniv.gift/tokutei.html',
      ],
      // 注: trailingSlash:'never' によりトップは 'https://anniv.gift'（末尾スラッシュ無し）で
      // 出力され、LP の canonical 'https://anniv.gift/' と表記が揃わない。
      // ただし RFC 3986 のスキーム別正規化で http(s) の空パスは '/' と等価に扱われるため
      // 実害はない（serialize で書き換えても、その後の正規化で剥がされる）。
    }),
  ],
});

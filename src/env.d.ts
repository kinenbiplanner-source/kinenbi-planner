/// <reference types="astro/client" />
/// <reference path="../worker-configuration.d.ts" />

/**
 * `App.Locals` の拡張。
 *
 * `App.Locals` は @astrojs/cloudflare の types.d.ts が既に `Runtime`（locals.runtime）で
 * 宣言しているので、ここは declaration merging で自前のフィールドを足すだけにする。
 *
 * `user` は src/middleware.ts が Cloudflare Access の JWT を検証した後にだけ入れる。
 * 「入っている＝認証済み」を型と実装の両方で担保したいので optional のままにし、
 * 管理画面では `Astro.locals.user?.email` の形で参照する。
 */
declare namespace App {
  interface Locals {
    user?: { email: string };
  }
}

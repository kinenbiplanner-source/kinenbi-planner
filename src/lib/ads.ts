/**
 * Google AdSense の設定（SSOT）。
 *
 * 方針は `メディア方針/収益化メモ.md` を参照。要点は3つ：
 *
 * 1. **広告は `/media` 配下の記事ページにだけ出す。** LP（`public/*.html`）には入れない。
 *    LPの目的は無料相談のCVで、立ち上げ期はCV1件のほうが広告収益より桁違いに大きい。
 * 2. **自動広告（Auto ads）は使わない。** Google に挿入位置を任せるとCLSと本文の
 *    読みやすさを制御できなくなる。枠はこのファイルで定義したものだけ。
 * 3. **CLIENT が空文字のあいだは、スクリプトも枠も一切出力されない。**
 *    審査に通ったら下の2か所を埋めるだけで有効になる。コードの変更は要らない。
 *
 * 有効化の手順：
 *   - `ADSENSE_CLIENT` に AdSense のパブリッシャーID（`ca-pub-…`）を入れる
 *   - AdSense管理画面で作った広告ユニットのスロットID（数字10桁）を `AD_SLOTS` に入れる
 *   - `public/ads.txt` の `pub-…` を同じIDに合わせる（食い違うと配信が止まる）
 */

/**
 * AdSense のパブリッシャーID。`ca-pub-` 始まり。空＝広告を一切出さない。
 * 型を `string` に固定してあるのは、空文字リテラル型に狭まると
 * 「この比較は常に false」と判定されて分岐が消えてしまうため。
 */
export const ADSENSE_CLIENT: string = '';

/**
 * 広告ユニットのスロットID。
 * **枠ごとに空にできる**（空の枠だけ描画されない）ので、
 * 「サイドだけ試す」「記事末尾を一時的に止める」が再デプロイだけでできる。
 */
export const AD_SLOTS: Record<'bottom' | 'side', string> = {
  /**
   * 記事末尾。CTA（無料相談）より **下** に置く。
   * CTAを押し下げると送客が減るので、この順番は入れ替えない。
   */
  bottom: '',
  /**
   * 左サイドの縦長（160×600 相当）。
   * `media.css` の `.art-ad` が 1440px 以上でだけ列を出すので、実質デスクトップ専用。
   */
  side: '',
};

export type AdSlotName = keyof typeof AD_SLOTS;

/** 広告を1つでも出す状態か。head の adsbygoogle.js を読むかの判断に使う。 */
export const adsEnabled: boolean =
  ADSENSE_CLIENT !== '' && Object.values(AD_SLOTS).some((s) => s !== '');

/**
 * SERP 要塞度の機械判定。
 *
 * `.claude/agents/reference/keyword-selection.md` 2章の表をコードに写したもの。**ルールの正はあちら**。
 * ここを変えるときは向こうも直す（quality.ts と style-guide の関係と同じ）。
 *
 * 上位10のURL（またはホスト名）を渡すと、7分類の件数と A/B/C を返す。
 * serp-difficulty-scout エージェントは WebSearch しか持たないので、
 * このコードを直接は叩けない——エージェントには SSOT の表を逐語で渡して人力分類させ、
 * その結果（分類ごとの件数）を `gradeFromCounts` に通して A/B/C を機械で出す。
 * 分類の主観は残るが、件数→A/B/C の閾値だけは人が忖度できない形にする。
 */
import type { SerpClass, SerpGrade, SerpVerdict } from './types.ts';

/**
 * 分類ごとの代表ドメイン。部分一致（`host.endsWith(domain)` か `host.includes(domain)`）。
 * 「単社オウンド」「公式」は業種で決まるので、ドメイン表では判定できない → unknown に落ちる。
 */
export const DOMAIN_CLASSES: Record<Exclude<SerpClass, 'owned' | 'official' | 'unknown'>, readonly string[]> = {
  ec: [
    'tanp.jp',
    'giftmall.co.jp',
    'anny.gift',
    'giftpedia.jp',
    'moodmarkgift.mistore.jp',
    'giftful.jp',
    'rakuten.co.jp',
    'amazon.co.jp',
    'zozo.jp',
    'shopping.yahoo.co.jp',
    'bellemaison.jp',
    'lohaco.yahoo.co.jp',
    'hibiyakadan.com',
    'nicoflor.jp',
    'giftmall',
    'present-pedia',
  ],
  booking: [
    'ozmall.co.jp',
    'ikyu.com',
    'tabelog.com',
    'gnavi.co.jp',
    'hotpepper.jp',
    'retty.me',
    'hitosara.com',
    'jalan.net',
    'travel.rakuten.co.jp',
    'rlx.jp',
    'booking.com',
    'tablecheck.com',
    'expedia.co.jp',
    'tripadvisor.jp',
    'asoview.com',
    'ikyu',
  ],
  affiliate: [
    'my-best.com',
    'kakaku.com',
    'sakidori.co',
    '4meee.com',
    'oggi.jp',
    'precious.jp',
    'ranking.goo.ne.jp',
    'kurashi-no.jp',
    'limia.jp',
    'mybest',
    'ranking',
    'osusume',
  ],
  personal: [
    'note.com',
    'ameblo.jp',
    'hatenablog',
    'hatenadiary',
    'chiebukuro.yahoo.co.jp',
    'oshiete.goo.ne.jp',
    'okwave.jp',
    'fc2.com',
    'livedoor',
    'seesaa',
    'exblog.jp',
    'blog.jp',
  ],
  social: ['instagram.com', 'x.com', 'twitter.com', 'youtube.com', 'youtu.be', 'tiktok.com', 'pinterest.jp', 'pinterest.com', 'threads.net'],
};

export const SERP_CLASS_LABEL: Record<SerpClass, string> = {
  ec: 'EC・ギフトモール',
  booking: '予約DB・グルメ',
  affiliate: 'ランキング・比較まとめ',
  owned: '単社オウンド',
  official: '公式',
  personal: '個人ブログ・Q&A',
  social: 'SNS・動画',
  unknown: '不明',
};

export const SERP_CLASSES: readonly SerpClass[] = ['ec', 'booking', 'affiliate', 'owned', 'official', 'personal', 'social', 'unknown'];

/** 「要塞側」＝EC＋予約DB＋ランキングまとめ。keyword-selection.md 2章「判定」 */
const FORTRESS: readonly SerpClass[] = ['ec', 'booking', 'affiliate'];

function hostOf(urlOrHost: string): string {
  const s = urlOrHost.trim();
  if (!s) return '';
  try {
    return new URL(s.includes('://') ? s : `https://${s}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return s.toLowerCase().replace(/^www\./, '');
  }
}

/** URL またはホスト名 → 分類。表に無ければ unknown（owned / official は人が決める）。 */
export function classifyDomain(urlOrHost: string): SerpClass {
  const host = hostOf(urlOrHost);
  if (!host) return 'unknown';
  for (const [cls, domains] of Object.entries(DOMAIN_CLASSES) as Array<[SerpClass, readonly string[]]>) {
    for (const d of domains) {
      if (host === d || host.endsWith(`.${d}`) || host.includes(d)) return cls;
    }
  }
  return 'unknown';
}

export function emptyCounts(): Record<SerpClass, number> {
  return { ec: 0, booking: 0, affiliate: 0, owned: 0, official: 0, personal: 0, social: 0, unknown: 0 };
}

export interface GradeInput {
  counts: Record<SerpClass, number>;
  /** 上位の大半が 2024 年以前（scout が読み取れたときだけ true） */
  stale?: boolean;
  /** anny.gift が上位にいる */
  hasAnny?: boolean;
}

/**
 * 分類ごとの件数 → A/B/C。閾値と補正は keyword-selection.md 2章と1文字も違わないこと。
 * 補正の適用順は「A に倒す補正 → C に倒す補正 → B に倒す補正」。
 * 予約DB 3件以上は他の補正より強い（在庫が無いと順位を取っても行動が完結しない）。
 */
export function gradeFromCounts(input: GradeInput): SerpVerdict {
  const c = input.counts;
  const fortress = FORTRESS.reduce((n, k) => n + (c[k] ?? 0), 0);
  const reasons: string[] = [];

  let grade: SerpGrade;
  if (fortress >= 6) {
    grade = 'A';
    reasons.push(`要塞側（EC＋予約DB＋ランキング）が ${fortress} 件`);
  } else if (fortress >= 3) {
    grade = 'B';
    reasons.push(`要塞側が ${fortress} 件で分散`);
  } else {
    grade = 'C';
    reasons.push(`要塞側が ${fortress} 件以下＝専門メディア不在`);
  }

  // A に倒す補正
  if ((c.booking ?? 0) >= 3) {
    grade = 'A';
    reasons.push(`予約DBが ${c.booking} 件＝在庫が無いと勝てない → A`);
  } else if ((c.official ?? 0) >= 3 && grade !== 'A') {
    grade = grade === 'C' ? 'B' : 'A';
    reasons.push(`公式が ${c.official} 件＝出所が固定 → A寄り`);
  }

  // C に倒す補正（A 判定には効かせない。要塞の中に個人ブログが混ざっても要塞は要塞）
  if (grade === 'B' && (c.personal ?? 0) >= 5) {
    grade = 'C';
    reasons.push(`個人ブログ・Q&A が ${c.personal} 件＝誰も本気で書いていない → C寄り（需要の裏取り必須）`);
  }

  // B に倒す補正（鮮度）。A → B にはしない（要塞は古くても要塞）。
  if (input.stale && grade === 'C') {
    reasons.push('上位が2024年以前ばかり（鮮度で割り込める）');
  } else if (input.stale && grade === 'A' && fortress < 6 && (c.booking ?? 0) < 3) {
    grade = 'B';
    reasons.push('上位が2024年以前ばかり → B寄り');
  }

  if (input.hasAnny) reasons.push('anny.gift が上位にいる：実務ディテールで勝てるかを必ず添える');

  return { grade, counts: { ...emptyCounts(), ...c }, reason: reasons.join('。') };
}

/** URL の配列から一気に判定する（scout の出力を機械で検算するとき用）。 */
export function gradeUrls(urls: string[], opts: { stale?: boolean } = {}): SerpVerdict & { classes: SerpClass[] } {
  const counts = emptyCounts();
  const classes = urls.map((u) => {
    const cls = classifyDomain(u);
    counts[cls] += 1;
    return cls;
  });
  const hasAnny = urls.some((u) => hostOf(u).includes('anny.gift'));
  return { ...gradeFromCounts({ counts, stale: opts.stale, hasAnny }), classes };
}

/** 台帳の difficulty（低/中/高）に寄せる。要塞度の粗い写像で、逆向きには使わない。 */
export function gradeToDifficulty(grade: SerpGrade | ''): string {
  return grade === 'A' ? '高' : grade === 'B' ? '中' : grade === 'C' ? '低' : '';
}

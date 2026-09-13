/**
 * KW の分かち書きと正規化。カニバリ検出（cannibal.ts）と内部リンク提案（internal-links.ts）の共通部品。
 *
 * 日本語KWは「記念日 レストラン 予約 いつから」のようにスペース区切りで台帳に入っている前提。
 * 形態素解析は持ち込まない（Worker のバンドルに辞書を入れたくない）。スペースで割って、
 * 表記ゆれを寄せるだけの軽い処理に留める。記事本文との照合（内部リンク）は
 * 「本文の段落にトークンが含まれるか」を見るので、本文側は分かち書きしない。
 *
 * **同義グループはこのメディア固有**。「ディナー」と「レストラン」を同じ語として扱わないと
 * 「記念日 ディナー 予算」と「記念日 レストラン 予算」が別KWに見えて共食いを見逃す。
 * 逆に「彼女」と「彼氏」は贈る相手が違う＝別記事でよいので寄せない。
 */

/**
 * 同義グループ。先頭が代表語（正規化後はこの語になる）。
 * 足すときは「検索意図が同じか」で判断する。字面が似ているだけの語は入れない。
 */
export const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['誕生日', 'バースデー', 'birthday'],
  ['記念日', 'アニバーサリー', 'anniversary'],
  ['プレゼント', 'ギフト', '贈り物', 'present', 'gift'],
  ['レストラン', 'ディナー', 'お店', '店', 'dinner'],
  ['予算', '相場', '値段', '価格', '費用', '料金', '金額'],
  ['サプライズ', '演出'],
  ['代行', 'プロデュース', 'コンシェルジュ', '依頼', '頼む', '頼みたい'],
  ['おすすめ', '人気', 'ランキング'],
  ['選び方', '選ぶ', '決め方', '選べない', '選び'],
  // 「付き合って1年」「交際3年」を 交際＋年数 に揃える（複合語の分割は既知語だけで行うため、ここに無いと割れない）
  ['交際', '付き合って', '付き合い', 'つきあって'],
  ['いつから', '何日前', 'タイミング', 'いつ', '時期'],
  ['伝え方', 'お願い', '頼み方', '言い方'],
  ['予約', '予約方法'],
  ['1年', '一年', '1周年', '一周年'],
  ['2年', '二年', '2周年', '二周年'],
  ['3年', '三年', '3周年', '三周年'],
  ['カップル', '恋人', '二人', '2人', 'ふたり'],
  ['旅行', '旅', '宿泊', '泊まり'],
  ['持ち込み', '持込'],
  ['アイデア', 'アイディア', 'idea', 'ネタ', '例'],
  ['失敗', 'ng', '注意点', '注意'],
  ['社会人', '20代', '30代'],
];

/** 単独では意味を持たない語。トークンから落とす。 */
const STOP_WORDS = new Set([
  'の', 'は', 'が', 'を', 'に', 'で', 'と', 'や', 'も', 'へ', 'か', 'な', 'ね', 'よ',
  'する', 'した', 'ある', 'いる', 'なる', 'こと', 'もの', 'ため', 'など', 'まで', 'から',
  'とは', 'について', 'に関して', 'まとめ', '方法', 'やり方',
  'and', 'or', 'the', 'a', 'of', 'to', 'in',
]);

const CANON = new Map<string, string>();
for (const group of SYNONYM_GROUPS) {
  const head = group[0]!;
  for (const w of group) CANON.set(w, head);
}

/**
 * 1語の正規化。NFKC で全角英数・カナを寄せ、小文字にし、同義グループの代表語に置き換える。
 * 「１年」→「1年」、「ＧＩＦＴ」→「gift」→「プレゼント」。
 */
export function canon(word: string): string {
  const w = word.normalize('NFKC').toLowerCase().trim();
  if (!w) return '';
  return CANON.get(w) ?? w;
}

/** 同義グループの全語（NFKC・小文字）。長い順。複合語の分割に使う。 */
const KNOWN_WORDS = [...new Set(SYNONYM_GROUPS.flat().map((w) => w.normalize('NFKC').toLowerCase()))].sort(
  (a, b) => b.length - a.length,
);

/**
 * スペース無しの複合語を既知語で割る。「誕生日プレゼント」→ ['誕生日', 'プレゼント']。
 * 台帳には「誕生日プレゼント 彼女 予算」のように詰めて入っているKWがあり、1トークンのままだと
 * 「誕生日 プレゼント 彼女」と重ならない（Jaccard に乗らない）。
 * 全体が既知語だけで構成できたときだけ割る。1語でも余ると元のまま返す（「センスない」を「センス」＋…に
 * 崩さない）。既知語は同義グループの語に限る——汎用の辞書を持ち込まず、このメディアの語彙だけで足りる範囲。
 */
function splitCompound(word: string): string[] {
  if (word.length < 4 || KNOWN_WORDS.includes(word)) return [word];
  const parts: string[] = [];
  let rest = word;
  while (rest) {
    const hit = KNOWN_WORDS.find((k) => k.length >= 2 && rest.startsWith(k));
    if (!hit) return [word];
    parts.push(hit);
    rest = rest.slice(hit.length);
  }
  return parts.length > 1 ? parts : [word];
}

/**
 * KW → トークン集合（重複なし・順序は元のまま）。
 * 区切りは半角/全角スペース・読点・中黒・スラッシュ。ストップワードは落とす。
 */
export function tokenize(keyword: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keyword.split(/[\s　、,・/／|｜]+/)) {
    const base = raw.normalize('NFKC').toLowerCase().trim();
    if (!base) continue;
    for (const piece of splitCompound(base)) {
      const w = canon(piece);
      if (!w || STOP_WORDS.has(w)) continue;
      if (seen.has(w)) continue;
      seen.add(w);
      out.push(w);
    }
  }
  return out;
}

/** 正規化したKW文字列（トークンをソートして結合）。完全一致の判定用。 */
export function normalizeKeyword(keyword: string): string {
  return [...tokenize(keyword)].sort().join(' ');
}

export interface Overlap {
  /** |A∩B| / |A∪B| */
  jaccard: number;
  /** A のトークンが B に何割含まれるか */
  coverA: number;
  /** B のトークンが A に何割含まれるか */
  coverB: number;
  common: string[];
}

export function overlap(a: string[], b: string[]): Overlap {
  if (a.length === 0 || b.length === 0) return { jaccard: 0, coverA: 0, coverB: 0, common: [] };
  const sb = new Set(b);
  const common = a.filter((t) => sb.has(t));
  const union = new Set([...a, ...b]).size;
  return {
    jaccard: common.length / union,
    coverA: common.length / a.length,
    coverB: common.length / b.length,
    common,
  };
}

/**
 * 本文（段落などの生テキスト）にトークンが含まれるか。
 * 本文側は分かち書きしないので、同義グループの**全メンバー**で部分一致を取る。
 * 「ディナー」で正規化されたトークンは、本文の「レストラン」「お店」にも当たる。
 */
export function textHasToken(text: string, token: string): boolean {
  const t = text.normalize('NFKC').toLowerCase();
  const group = SYNONYM_GROUPS.find((g) => g[0] === token);
  const words = group ? group.map((w) => w.normalize('NFKC').toLowerCase()) : [token];
  return words.some((w) => w.length > 0 && t.includes(w));
}

/** 本文にトークン集合が何割含まれるか（0〜1）。 */
export function textCoverage(text: string, tokens: string[]): { ratio: number; hit: string[] } {
  if (tokens.length === 0) return { ratio: 0, hit: [] };
  const hit = tokens.filter((tk) => textHasToken(text, tk));
  return { ratio: hit.length / tokens.length, hit };
}

/**
 * 手動 CSV（Google キーワードプランナー／ラッコキーワード）のパース。scripts/seo/volume.ts --csv の中身。
 *
 * 列名を決め打ちしない。ツールの UI 言語（英語／日本語）とバージョンでヘッダが変わり、決め打ちにすると
 * 次のエクスポートで黙って 0 件になる。ヘッダ行から「キーワードらしき列」「検索数らしき列」を推定し、
 * **どの列を使ったかを返す**（呼び出し側が表示して、人が目で確かめる）。
 *
 * 文字コードは呼び出し側の責任だが、判定は decodeCsvBytes に寄せてある：キーワードプランナーは
 * UTF-16LE（BOM 付き）＋タブ区切りで落ちてくることがあり、ラッコは UTF-8（BOM 付き）＋カンマ。
 * TextDecoder だけで書いてあるので Worker からも使える（node:fs には依存しない）。
 *
 * 値の表記はツールごとに違う：
 *   ラッコ無料版      … 「100〜1000」「1万〜10万」のレンジ
 *   キーワードプランナー … 「1K〜10K」「1万～10万」「100 – 1K」（請求先未設定だとレンジ）、または実数「1,300」
 * レンジは**下限**を採る（keyword-selection.md 4章）。「〜」「～」「-」「–」「—」を区切りとみなす。
 */

export interface VolumeRow {
  keyword: string;
  /** 月間検索数。レンジなら下限。読めなければ null */
  volume: number | null;
  /** レンジ表記だったときの元の文字列（「100〜1000」）。実数なら '' */
  range: string;
  /** KD／競合性の数値。列が無い・数値でない（Low/High）なら null */
  kd: number | null;
}

/** ヘッダ名の候補（部分一致・大文字小文字無視）。先に書いたものを優先する。 */
const KEYWORD_HEADERS = ['keyword', 'キーワード', '検索キーワード'];
const VOLUME_HEADERS = ['avg. monthly searches', '月間平均検索ボリューム', '月間検索数', '検索ボリューム', 'volume', '検索数'];
/**
 * KD 列。キーワードプランナーは「Competition」（Low/High の文字）と「Competition (indexed value)」（0〜100）の
 * 両方を持つので、数値の方を先に探す。
 */
const KD_HEADERS = ['kd', 'keyword difficulty', 'difficulty', 'competition (indexed', '競合性（インデックス', 'competition', '競合性'];

/** バイト列 → 文字列。BOM で UTF-16LE / UTF-16BE / UTF-8 を判定し、BOM は剥がす。 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  let text: string;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = new TextDecoder('utf-16le').decode(bytes.subarray(2));
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    text = new TextDecoder('utf-16be').decode(bytes.subarray(2));
  } else if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    text = new TextDecoder('utf-8').decode(bytes.subarray(3));
  } else {
    text = new TextDecoder('utf-8').decode(bytes);
  }
  return text.replace(/^\uFEFF/, '');
}

const UNIT: Record<string, number> = { k: 1_000, m: 1_000_000, 千: 1_000, 万: 10_000, 億: 100_000_000 };

/** 「1K」「1.5万」「1,300」→ 数値。読めなければ null。 */
function parseMagnitude(s: string): number | null {
  const m = s.match(/^(\d+(?:\.\d+)?)([km千万億])?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2] ? UNIT[m[2].toLowerCase()] ?? 1 : 1;
  return Math.round(n * unit);
}

/** "100〜1000" "1K–10K" "1,000" "10万" のような表記を数値に。レンジは下限。読めなければ null。 */
export function parseVolumeCell(cell: string): { volume: number | null; range: string } {
  // NFKC で全角数字・全角K を寄せる。「～」(U+FF5E) は「~」になるが「〜」(U+301C) は残るので両方を区切りに入れる
  const s = cell.normalize('NFKC').replace(/[,\s　]/g, '').trim();
  if (!s) return { volume: null, range: '' };
  const parts = s.split(/[〜~\-–—]/);
  if (parts.length >= 2) {
    // レンジ。下限が空（「-」だけ、「〜1000」）なら読めない扱い
    const low = parseMagnitude(parts[0]!);
    return { volume: low, range: low === null ? '' : cell.trim() };
  }
  return { volume: parseMagnitude(s), range: '' };
}

/**
 * 区切り文字つきテキスト → 2次元配列。引用符（"a, b" / 二重 "" のエスケープ / 引用内改行）に対応する。
 * ラッコのキーワード列に読点入りの語が来ても崩れないように、split では済ませない。
 */
function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
    } else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * ヘッダ配列から候補名に合う列を探す。完全一致を先に、次に部分一致。
 * exclude に当たるヘッダは部分一致から外す（「Keyword Difficulty」を KW 列にしないため）。
 */
function pickColumn(headers: string[], prefs: string[], exclude: string[] = []): number {
  const norm = headers.map((h) => h.normalize('NFKC').toLowerCase().trim());
  for (const p of prefs) {
    const i = norm.indexOf(p);
    if (i >= 0) return i;
  }
  for (const p of prefs) {
    const i = norm.findIndex((h) => h.includes(p) && !exclude.some((x) => h.includes(x)));
    if (i >= 0) return i;
  }
  return -1;
}

/** 数値らしい列の判定用。「1,300」「1K〜10K」「100〜1000」が読めれば数値列とみなす。 */
function looksNumeric(cell: string): boolean {
  return parseVolumeCell(cell).volume !== null;
}

/**
 * CSV 文字列 → 行。列名を決め打ちしない：ヘッダ行から「キーワードらしき列」「検索数らしき列」を推定する。
 * 見つからなければ「1列目をKW、最初の数字っぽい列を検索数」にフォールバックし、どの列を使ったかを返す。
 *
 * キーワードプランナーの CSV は先頭に「Keyword Stats 2026-09-10 ...」「2025-08-01 - 2026-07-31」の
 * 前置き行があってからヘッダが来るので、先頭行をヘッダと決めつけず、最初の 20 行から探す。
 */
export function parseVolumeCsv(text: string): { rows: VolumeRow[]; keywordCol: string; volumeCol: string } | { error: string } {
  const body = text.replace(/^\uFEFF/, '');
  if (!body.trim()) return { error: 'CSV が空' };

  // 区切り：先頭 20 行のどこかにタブがあればタブ区切り（キーワードプランナー）。無ければカンマ
  const head = body.split(/\r?\n/).slice(0, 20);
  const delim = head.some((l) => l.includes('\t')) ? '\t' : ',';
  const table = parseDelimited(body, delim).map((r) => r.map((c) => c.trim()));

  // ヘッダ行を探す：KW 列と検索数列の両方があるものを最優先、次に KW 列だけ、最後に 2 列以上ある最初の行
  const limit = Math.min(table.length, 20);
  let headerIdx = -1;
  let kwIdx = -1;
  let volIdx = -1;
  for (let i = 0; i < limit; i++) {
    const r = table[i]!;
    if (r.length < 2) continue;
    const k = pickColumn(r, KEYWORD_HEADERS, ['difficulty', 'kd']);
    const v = pickColumn(r, VOLUME_HEADERS);
    if (k >= 0 && v >= 0) {
      headerIdx = i;
      kwIdx = k;
      volIdx = v;
      break;
    }
    if (k >= 0 && headerIdx < 0) {
      headerIdx = i;
      kwIdx = k;
    }
  }
  if (headerIdx < 0) {
    headerIdx = table.findIndex((r) => r.length >= 2);
    if (headerIdx < 0) return { error: '2列以上ある行が無い（区切り文字を読み違えているかもしれない）' };
  }
  const header = table[headerIdx]!;
  const data = table.slice(headerIdx + 1).filter((r) => r.some((c) => c !== ''));
  if (data.length === 0) return { error: 'ヘッダの後にデータ行が無い' };

  // フォールバック：KW は 1 列目、検索数は「データ行で数値に読める最初の列」（KW 列以外）
  if (kwIdx < 0) kwIdx = 0;
  if (volIdx < 0) {
    const sample = data.slice(0, 5);
    volIdx = header.findIndex((_, i) => i !== kwIdx && sample.some((r) => looksNumeric(r[i] ?? '')));
    if (volIdx < 0) return { error: `検索数の列が見つからない（ヘッダ: ${header.join(' | ')}）` };
  }
  const kdIdx = pickColumn(header, KD_HEADERS);

  const rows: VolumeRow[] = [];
  for (const r of data) {
    const keyword = (r[kwIdx] ?? '').replace(/[\s　]+/g, ' ').trim();
    if (!keyword) continue;
    const { volume, range } = parseVolumeCell(r[volIdx] ?? '');
    let kd: number | null = null;
    if (kdIdx >= 0) {
      const n = Number((r[kdIdx] ?? '').normalize('NFKC').replace(/[%,\s]/g, ''));
      kd = Number.isFinite(n) && (r[kdIdx] ?? '').trim() !== '' ? Math.round(n) : null;
    }
    rows.push({ keyword, volume, range, kd });
  }
  return {
    rows,
    keywordCol: header[kwIdx] || `${kwIdx + 1}列目`,
    volumeCol: header[volIdx] || `${volIdx + 1}列目`,
  };
}

/**
 * Anniv 自前計測（/api/ev へのビーコン）。
 *
 * GA4 / Meta Pixel はこのファイルとは**別系統でそのまま残っている**。
 * あちらは詳細な行動分析を見る場所、こちらは /dashboard に出す数字の出どころ。
 * 数字は必ずズレるので突き合わせない（計測設計.md 8章と同じ立場）。
 *
 * ## このファイルがやること
 *
 *   1. 着地時にURLの UTM を読み、sessionStorage に持つ（以降のイベントに添付する）
 *   2. UTM が無ければ referrer から流入元を推定する
 *   3. page_view を1回送る
 *   4. クリックを1本の委譲リスナーで拾って送る
 *
 * ## リンク側の約束
 *
 *   - `data-ev="<イベント名>"` `data-ev-label="<発火場所 or 行き先>"` … 明示指定（LP・links）
 *   - `data-cta="form|line"` `data-cta-label="<発火場所>"`           … メディア既存の記法をそのまま拾う
 *   - `data-follow="<行き先>"`                                        … メディア既存の記法をそのまま拾う
 *
 * メディア側は **既存のマークアップに手を入れずに計測できる**（MediaLayout の
 * gtag リスナーとは独立して動く。同じクリックで GA4 と自前に1件ずつ飛ぶのが正しい）。
 *
 * ## ページ側から明示的に送りたいとき
 *
 *   window.annivTrack('form_complete', 'contact_form');
 *
 * フォーム送信の完了のように、クリックでは拾えないものはこれを呼ぶ。
 *
 * イベント名・流入元は**サーバ側（/api/ev）が許可リストで弾く**。
 * ここで好きな文字列を送っても記録されないので、新しい導線を足すときは
 * あちらの ALLOWED_NAMES と 計測設計.md 4章の表にも足すこと。
 */
(function () {
  'use strict';

  var ENDPOINT = '/api/ev';
  var STORE_KEY = 'anniv_attr';

  /** utm_source として認める値。/api/ev の ALLOWED_SOURCES と対。 */
  var SOURCES = {
    instagram: 1, x: 1, tiktok: 1, line: 1, meta_ads: 1,
    google: 1, yahoo: 1, bing: 1, other: 1, direct: 1
  };

  /** referrer のホスト → 流入元。UTM が付いていない流入を拾うための保険。 */
  var REFERRER_MAP = [
    ['instagram.com', 'instagram'],
    ['l.instagram.com', 'instagram'],
    ['x.com', 'x'],
    ['twitter.com', 'x'],
    ['t.co', 'x'],
    ['tiktok.com', 'tiktok'],
    ['line.me', 'line'],
    ['google.', 'google'],
    ['yahoo.', 'yahoo'],
    ['bing.com', 'bing']
  ];

  function clean(v, max) {
    if (typeof v !== 'string') return '';
    return v.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, max || 32);
  }

  function readStored() {
    try {
      var raw = sessionStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var v = JSON.parse(raw);
      return v && typeof v === 'object' ? v : null;
    } catch (e) {
      return null;
    }
  }

  function store(attr) {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(attr));
    } catch (e) {
      /* プライベートウィンドウなどで書けなくても、そのセッションの計測は続く */
    }
  }

  /**
   * 流入元を決める。
   *
   * **URLに UTM があれば必ず上書きする**（first-touch ではなく、その時点のクリック元を採る）。
   * SNSのプロフィールから入り直したときに、前の流入元が残っていると
   * 「どの投稿から来たか」が分からなくなるため。
   * UTM が無いときだけ、保存済み → referrer 推定 → direct の順で埋める。
   */
  function resolveAttr() {
    var params;
    try {
      params = new URLSearchParams(location.search);
    } catch (e) {
      params = null;
    }

    var utmSource = params ? clean(params.get('utm_source'), 16) : '';
    if (utmSource) {
      var attr = {
        source: SOURCES[utmSource] ? utmSource : 'other',
        medium: params ? clean(params.get('utm_medium'), 16) : '',
        campaign: params ? clean(params.get('utm_campaign'), 32) : ''
      };
      store(attr);
      return attr;
    }

    var saved = readStored();
    if (saved && saved.source) return saved;

    // referrer からの推定。同一ホストからの遷移は流入ではないので direct のまま。
    var ref = '';
    try {
      ref = document.referrer || '';
    } catch (e) {
      ref = '';
    }
    var guess = { source: 'direct', medium: '', campaign: '' };
    if (ref) {
      var host = '';
      try {
        var u = new URL(ref);
        host = u.hostname.toLowerCase();
        if (host === location.hostname) return guess;
      } catch (e) {
        host = '';
      }
      var matched = '';
      for (var i = 0; i < REFERRER_MAP.length; i++) {
        if (host.indexOf(REFERRER_MAP[i][0]) !== -1) {
          matched = REFERRER_MAP[i][1];
          break;
        }
      }
      if (matched) {
        guess.source = matched;
        guess.medium = matched === 'google' || matched === 'yahoo' || matched === 'bing' ? 'organic' : 'referral';
      } else if (host) {
        guess.source = 'other';
        guess.medium = 'referral';
      }
    }
    store(guess);
    return guess;
  }

  var attr = resolveAttr();

  function send(name, label) {
    var body = JSON.stringify({
      name: name,
      label: label || '',
      source: attr.source,
      medium: attr.medium,
      campaign: attr.campaign
    });
    try {
      // sendBeacon は文字列を text/plain で送る。プリフライトが起きず、
      // 遷移直前でも取りこぼしにくい（受け口は Content-Type を見ていない）。
      if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, body)) return;
    } catch (e) {
      /* 落ちたら fetch に回す */
    }
    try {
      fetch(ENDPOINT, { method: 'POST', body: body, keepalive: true, credentials: 'omit' });
    } catch (e) {
      /* 計測の失敗でページの動作を止めない */
    }
  }

  // ページ側のスクリプトから呼ぶための入口（フォーム完了など、クリックで拾えないもの）。
  window.annivTrack = send;

  /**
   * 読み込み順に依存しないための待ち行列。
   * `thanks.html` のように **head の中で完了イベントを撃つ**ページがあるので、
   * track.js より先に呼ばれても取りこぼさないようにする。ページ側はこう書く：
   *
   *   (window.annivQueue = window.annivQueue || []).push(['form_complete', 'tally_form']);
   *
   * ここに来た時点で溜まっているぶんを流し、以降は push した瞬間に送る配列に差し替える。
   */
  var queued = window.annivQueue || [];
  for (var qi = 0; qi < queued.length; qi++) {
    if (queued[qi] && queued[qi].length) send(queued[qi][0], queued[qi][1]);
  }
  window.annivQueue = { push: function (args) { if (args && args.length) send(args[0], args[1]); } };

  // 二重に読み込まれても page_view を2回送らない。
  if (!window.__annivPageViewSent) {
    window.__annivPageViewSent = true;
    // ラベルはパスから作る。`/media/foo-bar` → `media`、トップは `home`。
    var seg = (location.pathname || '/').split('/').filter(Boolean)[0] || 'home';
    send('page_view', clean(seg.replace(/\.html$/, ''), 32) || 'home');
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;

    // 1. 明示指定（LP・links.html）
    var ev = t.closest('[data-ev]');
    if (ev) {
      send(clean(ev.getAttribute('data-ev'), 24), clean(ev.getAttribute('data-ev-label')));
      return;
    }

    // 2. メディアの既存記法。マークアップを変えずに拾う
    var cta = t.closest('[data-cta]');
    if (cta) {
      var kind = cta.getAttribute('data-cta');
      var label = clean(cta.getAttribute('data-cta-label')) || 'article_cta';
      send(kind === 'line' ? 'line_add_click' : 'cta_click', label);
      return;
    }

    var follow = t.closest('[data-follow]');
    if (follow) {
      send('follow_click', clean(follow.getAttribute('data-follow')) || 'unknown');
      return;
    }

    // 3. 属性を持たないLINEリンクの取りこぼし（メディア共通フッターのアイコンなど）。
    // 計測設計.md の label に合わせて、メディア配下だけ media_footer と呼ぶ。
    var line = t.closest('a[href*="lin.ee"]');
    if (line) {
      send('line_add_click', location.pathname.indexOf('/media') === 0 ? 'media_footer' : 'footer');
    }
  });
})();

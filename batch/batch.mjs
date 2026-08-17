// bigdeal batch v1.0 — 모체(deal-salkka) 산출물 fetch → 정규화 → 앵커 병합 → 판정 재계산
// 실행: node batch/batch.mjs            (Actions 01:10 KST)
//       node batch/batch.mjs --allow-stale   (로컬 테스트 전용 — 모체 날짜 검사 생략)
//
// ★ 모체 코드·저장소·스케줄러를 건드리지 않는다. 퍼블릭 산출물을 읽기만 한다.
// ★ 모체가 낡았으면 오늘 이력에 값을 쓰지 않고 exit(1) — Actions가 빨개져서 즉시 안다.
// ★ 모체 판정은 버리고 priceHistory만 승계, 판정은 여기서 재계산한다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'deals-latest.json');
const ANCHORS = path.join(ROOT, 'data', 'anchors.json');

const SOURCE_URL = process.env.BIGDEAL_SOURCE_URL
  || 'https://raw.githubusercontent.com/kdh0725-bit/deal-salkka-data/main/data/deals-latest.json';

const SITE_CODE = 'A100706845';           // ★ bigdeal 전용. 모체(A100706842) 혼입 금지

// ★ 모체 불가침 — 이 스크립트가 실수로 모체 저장소 안에서 실행되는 경우를 차단한다.
//   ROOT 는 스크립트 위치에서 파생되므로, 파일을 잘못 복사하면 모체에 써버릴 수 있다.
if (/deal-salkka/i.test(ROOT)) {
  console.error(`★ 중단: 모체 저장소 안에서 실행됐다 (${ROOT}). bigdeal-data 에서 실행할 것.`);
  process.exit(1);
}
const FORBIDDEN_SITE_CODE = 'A100706842';
const MIN_VERDICT_DAYS = 7;
const ALLOW_STALE = process.argv.includes('--allow-stale');

const VERSION = 'bigdeal-batch v1.4';  // v1.3: 자기 이력 승계 / v1.4: 변화 원인 귀속 리셋
console.log(`[${VERSION}]`);

// ── 날짜 유틸 ────────────────────────────────────────────────
const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

// ── 판정 — 모체 flat 사고([C8])의 교훈을 처음부터 반영 ─────────
// 규칙(공식 의미: priceHistory = "그날 구매 가능했던 최저가"):
//   pending      기록일수 < 7
//   flat         기록 전체가 같은 가격 (움직인 적 없는 가격은 최저가가 아니다)
//   alltime_low  오늘가 == 역대 최저 (가격이 움직인 적 있는 상품만)
//   normal       오늘가 <= 중앙값
//   higher       오늘가 >  중앙값
// ★ v1.2 — 스코프(비교 대상 판매처 집합)가 바뀐 날은 기준선을 리셋한다.
//   이유: 이력은 "그날 구매 가능했던 최저가"다. 앵커를 붙이면 가격이 1원도 안 움직였는데
//   오늘 값만 낮아져 '역대 최저'가 터진다. 반대로 앵커가 만료돼 빠지면 '평소보다 비쌈'이 터진다.
//   → 판정은 항상 "마지막 스코프 변경 이후 구간(window)"에서만 계산한다.
//   레거시 레코드(k 없음)는 n 으로 서명한다 — 모체 승계분은 전부 토스 단독이라 안전하다.
export const scopeKey = r => r.k || (r.n === 1 ? '토스쇼핑' : `n${r.n ?? 1}`);

const scopeSet = r => {
  if (r.k) return new Set(String(r.k).split('|'));
  if ((r.n ?? 1) === 1) return new Set([r.s || '토스쇼핑']);
  return null;                                   // 레거시 다곳 레코드 — 구성을 알 수 없다
};

export function scopeWindow(h) {
  let start = 0, dir = null, from = null, to = null;
  for (let i = 1; i < h.length; i++) {
    const prev = h[i - 1], cur = h[i];
    if (scopeKey(cur) === scopeKey(prev)) continue;
    if (cur.price === prev.price) continue;      // 최저가 수준이 그대로면 시계열은 이어진다

    // ★ v1.4 — 스코프가 바뀌고 가격도 움직였을 때, 그 움직임의 원인이 스코프 변경인지 본다.
    //   원인이 아니면(기존 판매처가 스스로 가격을 바꾼 것이면) 리셋하지 않는다.
    //   그러지 않으면 "같은 날 토스가 내렸는데 앵커를 붙였다"는 이유로 판정이 통째로 보류된다.
    const ps = scopeSet(prev), cs = scopeSet(cur);
    let caused = true;                            // 구성을 모르면(레거시) 보수적으로 리셋
    if (ps && cs) {
      const added = [...cs].filter(x => !ps.has(x));
      const removed = [...ps].filter(x => !cs.has(x));
      const byNewSeller = added.includes(cur.s);        // 새로 들어온 곳이 최저가가 됐다
      const lostBestSeller = removed.includes(prev.s);  // 최저가였던 곳이 빠졌다
      caused = byNewSeller || lostBestSeller;
    }
    if (!caused) continue;

    start = i; from = prev; to = cur;
    dir = (cur.n ?? 1) > (prev.n ?? 1) ? 'expand' : (cur.n ?? 1) < (prev.n ?? 1) ? 'shrink' : 'swap';
  }
  return { win: h.slice(start), start, dir, from, to };
}

export function verdictOf(history) {
  const h = (history || []).filter(r => Number.isFinite(r.price));
  if (!h.length) return { verdict: 'pending', verdictDays: 0, verdictMin: null, histDays: 0 };
  const histDays = new Set(h.map(r => r.date)).size;
  const { win, dir, from, to } = scopeWindow(h);
  const days = new Set(win.map(r => r.date)).size;
  const prices = win.map(r => r.price);
  const min = Math.min(...prices), max = Math.max(...prices);
  const base = { verdictDays: days, verdictMin: min, histDays };

  // 스코프가 넓어졌고 그 새 판매처가 실제로 최저가를 낮췄을 때만 사실을 말한다
  if (dir === 'expand' && days < MIN_VERDICT_DAYS && to.price < from.price) {
    return { ...base, verdict: 'scope_new', scopeDir: 'expand', scopeBy: to.s ?? null, scopeDelta: from.price - to.price };
  }
  if (days < MIN_VERDICT_DAYS) {
    return { ...base, verdict: 'pending', ...(dir ? { scopeDir: dir } : {}) };
  }
  if (min === max) return { ...base, verdict: 'flat' };
  const today = win[win.length - 1].price;
  if (today <= min) return { ...base, verdict: 'alltime_low' };
  const sorted = [...prices].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return { ...base, verdict: today <= median ? 'normal' : 'higher' };
}

// ── 이력 — n(당일 판매처 수)·s(당일 최저 판매처) 주석 ──────────
// 과거 레코드(모체 승계분)는 토스 단독이었으므로 n:1, s:'토스쇼핑' — 사실 그대로.
// 오늘 레코드는 "오늘 확인된 판매처"의 최저가만 쓴다. 이틀 전 확인가로 오늘을 덮지 않는다.
// ★ v1.3 — bigdeal 은 자기 이력을 승계한다.
//   v1.2 까지는 매 실행마다 이력을 모체에서 다시 만들었다(전 레코드 n:1 · 토스쇼핑 고정).
//   그러면 어제 앵커가 최저였던 사실이 오늘 사라지고, 증강 상품은 매일 "스코프 변경 첫날"이 돼
//   영원히 scope_new/pending 에 갇힌다. 앵커 가격 추이도 영영 안 쌓인다.
//   → 우리 산출물의 이력을 우선하고, 우리가 빠뜨린 날짜만 모체로 메운다.
export function seedHistory(prevOwn, tossHistory) {
  const byDate = new Map();
  for (const r of (tossHistory || [])) {
    if (Number.isFinite(r.price)) byDate.set(r.date, { date: r.date, price: r.price, n: 1, s: '토스쇼핑' });
  }
  for (const r of (prevOwn || [])) {        // 우리 기록이 이긴다 — 앵커 포함 최저가이므로 정보량이 많다
    if (Number.isFinite(r.price)) byDate.set(r.date, { ...r });
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function buildHistory(base, sellers, today) {
  // 기본값을 먼저 깔고 실제 필드로 덮는다 — 모체 원본 레코드({date,price})가 그대로 들어와도
  // n=1 · s='토스쇼핑' 으로 정규화된다(v1.2 이전 호출 방식 호환).
  const hist = (base || []).map(r => ({ n: 1, s: '토스쇼핑', ...r }));
  const fresh = (sellers || []).filter(s => s.checkedAt === today && Number.isFinite(s.price));
  if (!fresh.length) return hist;
  const best = fresh.reduce((a, b) => (b.price < a.price ? b : a));
  // k = 그날 확인된 판매처 집합 서명. 수가 같아도 구성이 바뀌면(스왑) 스코프 변경이다.
  const k = [...new Set(fresh.map(s => s.name))].sort().join('|');
  const rec = { date: today, price: best.price, n: fresh.length, s: best.name, k };
  const i = hist.findIndex(r => r.date === today);
  if (i >= 0) hist[i] = rec; else hist.push(rec);
  return hist;
}

// ── 정규화: 모체 아이템 → bigdeal 스키마 ────────────────────
function normalizeTossItem(it, tossDate) {
  return {
    id: `toss-${it.id}`,
    source: 'toss',
    merchantType: 'commerce',
    category: it.category ?? null,
    categoryName: it.categoryName ?? null,
    name: it.name,
    thumb: it.thumb ?? null,
    orig: it.original ?? null,
    discount: it.discount ?? null,
    score: it.score ?? null,
    reviews: it.reviews ?? null,
    rank: it.rank ?? null,
    bestRank: it.bestRank ?? null,
    todayRank: it.todayRank ?? null,
    endAt: it.endAt ?? null,
    tossSource: it.source ?? null,   // 'best' | 'today_deal' — 인기/핫딜 탭 분류용
    themes: Array.isArray(it.themes) && it.themes.length ? it.themes : null,   // 모체 테마 승계 (장보기·쟁여두기…)
    sellers: [{
      name: '토스쇼핑',
      price: it.price,
      productUrl: it.link,           // 토스는 쉐어링크가 유일한 진입 URL — 원본으로 보관
      link: it.link,
      checkedAt: tossDate,
    }],
    priceHistory: null,              // 아래에서 채움
    verdict: null, verdictDays: null, verdictMin: null,
  };
}

// ── 앵커 병합 (수작업 증강) ──────────────────────────────────
// data/anchors.json:
// { "anchors": [
//     { "target": "toss-37721185",                 // 기존 상품 증강
//       "sellers": [{ "name":"하이마트","price":9200,
//                     "productUrl":"https://...","link":"https://click.linkprice.com/...&a=A100706845...",
//                     "checkedAt":"2026-08-15" }] },
//     { "target": null, "product": { ...신규 상품 정의(name·thumb·category 등)... },
//       "sellers": [...] }                          // 독립 등록
// ] }
function mergeAnchors(items, anchors) {
  const byId = new Map(items.map(it => [it.id, it]));
  let augmented = 0, standalone = 0;
  const skipped = [];
  for (const a of anchors?.anchors || []) {
    for (const s of a.sellers || []) {
      if (s.link && !s.link.includes(SITE_CODE)) throw new Error(`앵커 링크에 사이트코드 ${SITE_CODE} 없음: ${s.link}`);
      if (s.link && s.link.includes(FORBIDDEN_SITE_CODE)) throw new Error(`모체 사이트코드 혼입: ${s.link}`);
      if (!s.productUrl) throw new Error(`앵커 seller에 productUrl(원본) 누락: ${s.name}`);
    }
    if (a.target && byId.has(a.target)) {
      const it = byId.get(a.target);
      it.sellers.push(...a.sellers);
      it.source = 'mixed';
      augmented++;
    } else if (!a.target && a.product) {
      const p = a.product;
      items.push({
        id: p.id, source: 'linkprice', merchantType: p.merchantType ?? 'commerce',
        category: p.category ?? null, categoryName: p.categoryName ?? null,
        name: p.name, thumb: p.thumb ?? null, orig: p.orig ?? null,
        discount: null, score: null, reviews: null,
        rank: null, bestRank: null, todayRank: null, endAt: null, tossSource: null,
        sellers: a.sellers, tossHistory: p.priceHistory ?? [],
        priceHistory: null, verdict: null, verdictDays: null, verdictMin: null,
      });
      standalone++;
    } else if (a.target) {
      // ★ 모체 목록은 하루 24% 가 교체된다. 앵커 대상이 빠지는 건 정상이므로 실패시키지 않되,
      //   조용히 사라지면 안 된다 — 요약에 실어 check.html 에서 보이게 한다.
      console.warn(`⚠️ 앵커 대상 없음(모체 목록에서 빠짐): ${a.target} — 건너뜀`);
      skipped.push(a.target);
    }
  }
  return { augmented, standalone, skipped };
}

// ── 메인 ────────────────────────────────────────────────────
async function main() {
  const today = kstToday();

  // ① 모체 산출물 읽기 — 로컬 파일 또는 원격 URL
  //   BIGDEAL_SOURCE_FILE 이 있으면 로컬을 읽는다 (raw.githubusercontent 429 우회 · 오프라인 작업)
  //   원격은 429/5xx 에 한해 지수 백오프로 3회 재시도한다.
  let src;
  const localSrc = process.env.BIGDEAL_SOURCE_FILE
    || (/^file:/i.test(SOURCE_URL) ? fileURLToPath(SOURCE_URL) : (/^https?:/i.test(SOURCE_URL) ? null : SOURCE_URL));
  if (localSrc) {
    if (!fs.existsSync(localSrc)) { console.error(`모체 파일 없음: ${localSrc}`); process.exit(1); }
    console.log(`모체 소스: 로컬 ${localSrc}`);
    src = JSON.parse(fs.readFileSync(localSrc, 'utf8'));
  } else {
    let res = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      res = await fetch(SOURCE_URL, { headers: { 'User-Agent': 'bigdeal-batch' } });
      if (res.ok) break;
      if (![429, 500, 502, 503, 504].includes(res.status) || attempt === 3) break;
      const wait = attempt * 5000;
      console.warn(`⚠️ HTTP ${res.status} — ${wait / 1000}초 후 재시도 (${attempt}/3)`);
      await new Promise(r => setTimeout(r, wait));
    }
    if (!res.ok) {
      console.error(`모체 fetch 실패: HTTP ${res.status}`);
      if (res.status === 429) console.error('   → IP 요청 제한. BIGDEAL_SOURCE_FILE 로 로컬 파일을 지정해 우회할 수 있다.');
      process.exit(1);
    }
    src = await res.json();
  }
  console.log(`모체: date=${src.date} generatedAt=${src.generatedAt} items=${src.items?.length}`);

  // ② 신선도 게이트 — 낡은 값을 오늘 이력에 박으면 소급 복구 불가
  if (src.date !== today) {
    if (!ALLOW_STALE) { console.error(`★ 모체가 낡음: ${src.date} != 오늘(${today}). 중단.`); process.exit(1); }
    console.warn(`⚠️ --allow-stale: 모체 날짜(${src.date}) 기준으로 진행 (로컬 테스트 전용)`);
  }
  const baseDate = src.date;

  // ③ 정규화
  const items = src.items.map(it => normalizeTossItem(it, baseDate));
  const tossHistoryById = new Map(src.items.map(it => [`toss-${it.id}`, it.priceHistory || []]));

  // ③-2 우리 이전 산출물의 이력 승계 (없으면 최초 실행 — 모체로 시딩)
  let prevById = new Map();
  if (fs.existsSync(OUT)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      prevById = new Map((prev.items || []).map(it => [it.id, it.priceHistory || []]));
      const prevMax = [...prevById.values()].flat().reduce((m, r) => (r.date > m ? r.date : m), '');
      if (prevMax > baseDate) { console.error(`★ 이전 산출물이 미래 날짜(${prevMax} > ${baseDate}). 중단.`); process.exit(1); }
      console.log(`이력 승계: ${prevById.size}건 (최신 ${prevMax || '없음'})`);
    } catch (e) { console.warn(`⚠️ 이전 산출물 읽기 실패 — 모체로 시딩: ${e.message}`); }
  } else console.log('이력 승계: 이전 산출물 없음 — 모체로 시딩');

  // ④ 앵커 병합
  let anchors = null;
  if (fs.existsSync(ANCHORS)) anchors = JSON.parse(fs.readFileSync(ANCHORS, 'utf8'));
  const { augmented, standalone, skipped } = mergeAnchors(items, anchors);

  // ⑤ 이력 구성 + 판정 재계산
  for (const it of items) {
    const base = seedHistory(prevById.get(it.id), it.tossHistory ?? tossHistoryById.get(it.id) ?? []);
    delete it.tossHistory;
    it.priceHistory = buildHistory(base, it.sellers, baseDate);
    Object.assign(it, verdictOf(it.priceHistory));
  }

  // ⑥ 요약 + 저장
  const verdicts = {};
  for (const it of items) verdicts[it.verdict] = (verdicts[it.verdict] || 0) + 1;
  const multi = items.filter(it => it.sellers.length >= 2).length;
  const out = {
    generatedAt: new Date().toISOString(),
    date: baseDate,
    schema: 1,
    themes: src.themes ?? [],   // 테마 정의(id·label) — 칩 라벨용
    app: 'bigdeal',
    summary: { total: items.length, multiSeller: multi, augmented, standalone, skipped, verdicts },
    items,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`✅ ${OUT}`);
  console.log(`   total=${items.length} multiSeller=${multi} augmented=${augmented} standalone=${standalone} skipped=${skipped.length}`);
  console.log(`   verdicts=${JSON.stringify(verdicts)}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch(e => { console.error(e); process.exit(1); });

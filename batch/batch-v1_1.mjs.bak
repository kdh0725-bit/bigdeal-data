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
const FORBIDDEN_SITE_CODE = 'A100706842';
const MIN_VERDICT_DAYS = 7;
const ALLOW_STALE = process.argv.includes('--allow-stale');

const VERSION = 'bigdeal-batch v1.0';
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
export function verdictOf(history) {
  const h = (history || []).filter(r => Number.isFinite(r.price));
  const days = new Set(h.map(r => r.date)).size;
  if (days < MIN_VERDICT_DAYS) return { verdict: 'pending', verdictDays: days, verdictMin: h.length ? Math.min(...h.map(r => r.price)) : null };
  const prices = h.map(r => r.price);
  const min = Math.min(...prices), max = Math.max(...prices);
  const today = h[h.length - 1].price;
  if (min === max) return { verdict: 'flat', verdictDays: days, verdictMin: min };
  if (today <= min) return { verdict: 'alltime_low', verdictDays: days, verdictMin: min };
  const sorted = [...prices].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return { verdict: today <= median ? 'normal' : 'higher', verdictDays: days, verdictMin: min };
}

// ── 이력 — n(당일 판매처 수)·s(당일 최저 판매처) 주석 ──────────
// 과거 레코드(모체 승계분)는 토스 단독이었으므로 n:1, s:'토스쇼핑' — 사실 그대로.
// 오늘 레코드는 "오늘 확인된 판매처"의 최저가만 쓴다. 이틀 전 확인가로 오늘을 덮지 않는다.
export function buildHistory(tossHistory, sellers, today) {
  const hist = (tossHistory || []).map(r => ({ date: r.date, price: r.price, n: 1, s: '토스쇼핑' }));
  const fresh = (sellers || []).filter(s => s.checkedAt === today && Number.isFinite(s.price));
  if (!fresh.length) return hist;
  const best = fresh.reduce((a, b) => (b.price < a.price ? b : a));
  const rec = { date: today, price: best.price, n: fresh.length, s: best.name };
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
      console.warn(`⚠️ 앵커 대상 없음(모체 목록에서 빠짐): ${a.target} — 건너뜀`);
    }
  }
  return { augmented, standalone };
}

// ── 메인 ────────────────────────────────────────────────────
async function main() {
  const today = kstToday();

  // ① 모체 산출물 fetch
  const res = await fetch(SOURCE_URL);
  if (!res.ok) { console.error(`모체 fetch 실패: HTTP ${res.status}`); process.exit(1); }
  const src = await res.json();
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

  // ④ 앵커 병합
  let anchors = null;
  if (fs.existsSync(ANCHORS)) anchors = JSON.parse(fs.readFileSync(ANCHORS, 'utf8'));
  const { augmented, standalone } = mergeAnchors(items, anchors);

  // ⑤ 이력 구성 + 판정 재계산
  for (const it of items) {
    const base = it.tossHistory ?? tossHistoryById.get(it.id) ?? [];
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
    app: 'bigdeal',
    summary: { total: items.length, multiSeller: multi, augmented, standalone, verdicts },
    items,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`✅ ${OUT}`);
  console.log(`   total=${items.length} multiSeller=${multi} augmented=${augmented} standalone=${standalone}`);
  console.log(`   verdicts=${JSON.stringify(verdicts)}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch(e => { console.error(e); process.exit(1); });

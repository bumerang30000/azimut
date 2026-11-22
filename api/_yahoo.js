// Общий клиент Yahoo Finance: библиотека сама проходит cookie+crumb, без неё Yahoo часто отвечает 429
import YahooFinance from 'yahoo-finance2';
export const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'], validation: { logErrors: false } });
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
export function cors(res, sMaxAge = 60) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // кэш на CDN Vercel: повторные запросы не тратят лимит функций
  res.setHeader('Cache-Control', `public, s-maxage=${sMaxAge}, stale-while-revalidate=${sMaxAge * 4}`);
}

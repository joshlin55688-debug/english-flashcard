(function (global) {
  'use strict';

  function localDateStr(date) {
    const d = date ? (date instanceof Date ? date : new Date(date)) : new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function isDue(card, now) {
    if (!card || card.status === 'new') return false;
    const t = now !== undefined ? now : Date.now();
    return card.due <= t;
  }

  function quizRating(isCorrect) {
    return isCorrect ? 3 : 0;
  }

  function applyReview(streak, today) {
    const s = streak || {};
    const week = Object.assign({}, s.week);
    week[today] = (week[today] || 0) + 1;

    let count = 1;
    if (s.last) {
      if (s.last === today) {
        count = s.count || 1;
      } else {
        const [y1, m1, d1] = s.last.split('-').map(Number);
        const [y2, m2, d2] = today.split('-').map(Number);
        const diffDays = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
        if (diffDays === 1) {
          count = (s.count || 0) + 1;
        } else {
          count = 1;
        }
      }
    }

    return {
      last: today,
      count: count,
      week: week
    };
  }

  function mergeStates(local, remote) {
    const l = local || {};
    const r = remote || {};
    const merged = {};

    const keys = new Set([...Object.keys(l), ...Object.keys(r)]);

    for (const key of keys) {
      if (key === '_streak') {
        const ls = l._streak;
        const rs = r._streak;
        if (!ls && !rs) continue;
        if (!ls) {
          merged._streak = {
            last: rs.last || '',
            count: rs.count || 0,
            week: Object.assign({}, rs.week)
          };
          continue;
        }
        if (!rs) {
          merged._streak = {
            last: ls.last || '',
            count: ls.count || 0,
            week: Object.assign({}, ls.week)
          };
          continue;
        }

        let last = '';
        let count = 0;
        const lLast = ls.last || '';
        const rLast = rs.last || '';

        if (lLast > rLast) {
          last = lLast;
          count = ls.count || 0;
        } else if (rLast > lLast) {
          last = rLast;
          count = rs.count || 0;
        } else {
          last = lLast;
          count = Math.max(ls.count || 0, rs.count || 0);
        }

        const mergedWeek = {};
        const allDays = new Set([
          ...Object.keys(ls.week || {}),
          ...Object.keys(rs.week || {})
        ]);
        for (const day of allDays) {
          mergedWeek[day] = Math.max(
            (ls.week && ls.week[day]) || 0,
            (rs.week && rs.week[day]) || 0
          );
        }

        merged._streak = {
          last: last,
          count: count,
          week: mergedWeek
        };
      } else {
        const cardL = l[key];
        const cardR = r[key];
        if (cardL && !cardR) {
          merged[key] = Object.assign({}, cardL);
        } else if (!cardL && cardR) {
          merged[key] = Object.assign({}, cardR);
        } else if (cardL && cardR) {
          // modifiedAt 涵蓋復原評分：lastReview 會倒退，但這仍是最新的修改
          const revL = cardL.modifiedAt || cardL.lastReview || 0;
          const revR = cardR.modifiedAt || cardR.lastReview || 0;
          if (revR > revL) {
            merged[key] = Object.assign({}, cardR);
          } else if (revL > revR) {
            merged[key] = Object.assign({}, cardL);
          } else {
            const repsL = cardL.reps || 0;
            const repsR = cardR.reps || 0;
            if (repsR > repsL) {
              merged[key] = Object.assign({}, cardR);
            } else {
              merged[key] = Object.assign({}, cardL);
            }
          }
        }
      }
    }

    return merged;
  }

  // 與 Anki／py-fsrs 相同的 fuzz 區間，避免同時學的字集中在同一天到期
  const FUZZ_RANGES = [
    { start: 2.5, end: 7, factor: 0.15 },
    { start: 7, end: 20, factor: 0.1 },
    { start: 20, end: Infinity, factor: 0.05 }
  ];

  function fuzzInterval(days, rand) {
    if (days < 2.5) return days;
    let delta = 1;
    for (const r of FUZZ_RANGES) {
      delta += r.factor * Math.max(Math.min(days, r.end) - r.start, 0);
    }
    const max = Math.round(days + delta);
    const min = Math.min(Math.max(2, Math.round(days - delta)), max);
    const x = rand === undefined ? Math.random() : rand;
    return Math.floor(x * (max - min + 1)) + min;
  }

  // 由卡片狀態推算今日用量，因此多裝置與復原評分都不必另外記帳
  function dailyCounts(state, today) {
    const counts = { newCards: 0, reviews: 0 };
    const s = state || {};
    for (const key of Object.keys(s)) {
      if (key === '_streak') continue;
      const card = s[key];
      if (!card) continue;
      if (card.firstSeen === today) counts.newCards++;
      else if (card.lastReview && localDateStr(new Date(card.lastReview)) === today) counts.reviews++;
    }
    return counts;
  }

  // limit 為 0 代表不限
  function remaining(limit, used) {
    return limit === 0 ? Infinity : Math.max(0, limit - used);
  }

  function compactForSync(state) {
    const result = {};
    const s = state || {};
    for (const key of Object.keys(s)) {
      const val = s[key];
      if (key === '_streak') {
        result[key] = val;
      } else if (val && val.status === 'new' && (val.reps === 0 || !val.reps) && !val.modifiedAt) {
        continue;
      } else {
        result[key] = val;
      }
    }
    return result;
  }

  function makeBackup(state, now) {
    return {
      app: 'flashlearn',
      exportedAt: now !== undefined ? now : Date.now(),
      state: state
    };
  }

  function parseBackup(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('Invalid JSON');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Invalid backup root');
    }
    if (data.app !== 'flashlearn') {
      throw new Error('Invalid app');
    }
    if (!data.state || typeof data.state !== 'object' || Array.isArray(data.state)) {
      throw new Error('Invalid state');
    }
    for (const key of Object.keys(data.state)) {
      const val = data.state[key];
      if (!val || typeof val !== 'object' || Array.isArray(val)) {
        throw new Error(`Invalid state value for ${key}`);
      }
    }
    return data.state;
  }

  const FlashCore = {
    localDateStr: localDateStr,
    isDue: isDue,
    quizRating: quizRating,
    applyReview: applyReview,
    mergeStates: mergeStates,
    compactForSync: compactForSync,
    fuzzInterval: fuzzInterval,
    dailyCounts: dailyCounts,
    remaining: remaining,
    makeBackup: makeBackup,
    parseBackup: parseBackup
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = FlashCore;
  }
  if (typeof global !== 'undefined') {
    global.FlashCore = FlashCore;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

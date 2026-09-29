// Offline assistant: understands small talk, follow-ups, TerraX help
// topics, unit conversions, solar times and questions about the current
// results, without any network or AI model.
import { analyzeMetric, numericColumns } from '../analysis';
import { formatDate } from '../dates';
import { formatClock, solarReport } from '../solar';
import { fmt, fmtP } from '../stats';
import type { Dataset } from '../types';
import { STARTER_SUGGESTIONS, TOPICS, type Topic } from './knowledge';

export { STARTER_SUGGESTIONS };
import { normalize, tokenMatch, tokens, words } from './nlp';

export interface AssistantContext {
  operator?: string;
  target: { lat: number; lon: number; name: string };
  now?: Date;
  /** Current results (Markdown) and optional dataset, for the results assistant. */
  results?: { toolName: string; name: string; markdown: string; dataset?: Dataset; focus?: string | null };
}

export interface AssistantReply {
  text: string;
  suggestions: string[];
  topic?: string;
}

interface CompiledTopic extends Topic {
  compiled: { token: string; weight: number }[][];
}

const COMPILED: CompiledTopic[] = TOPICS.map(t => {
  // Multi-word keywords become token sequences; all tokens must match.
  // Synonyms can map two keywords to one token, so keep each token once
  // (with its highest weight) to avoid counting a query word twice.
  const groups = new Map<string, { token: string; weight: number }[]>();
  for (const [k, w] of Object.entries(t.keywords)) {
    const g = tokens(k).map(token => ({ token, weight: w }));
    if (!g.length) continue;
    const key = g.map(x => x.token).join(' ');
    const prev = groups.get(key);
    if (!prev || prev[0].weight < w) groups.set(key, g);
  }
  return { ...t, compiled: [...groups.values()] };
});

const byId = new Map(COMPILED.map(t => [t.id, t]));

// ── Small talk ──────────────────────────────────────────────────────────

const RE = {
  greet: /^(hi+|hello+|hey+|hiya|howdy|namaste|namaskar|hola|yo|hlo|helo|greetings|good (morning|afternoon|evening|day))\b/,
  howAreYou: /\b(how are (you|u)|how r u|how('s| is) it going|how do you do|what'?s up|wassup|sup)\b/,
  whoAreYou: /\b(who are you|what are you|your name|who made you|are you (a )?(bot|robot|ai|human|real))\b/,
  capabilities: /\b(what can you do|what do you do|how can you help|what (can|should) i ask|capabilit|features?|^help$|help me|menu|options)\b/,
  thanks: /\b(thanks?|thank ?you|thx|ty|appreciate|cheers)\b/,
  praise: /^(great|awesome|nice|cool|perfect|good job|well done|amazing|excellent|wow|brilliant|super|love it)\b/,
  bye: /\b(bye|goodbye|good ?night|see (you|ya)|cya|take care|that'?s all|exit|quit)\b/,
  yes: /^(yes|yeah|yep|yup|sure|ok(ay)?|please( do)?|go ahead|y|of course|definitely)\b[.! ]*$/,
  no: /^(no|nope|nah|not now|no thanks|never ?mind|cancel)\b[.! ]*$/,
  frustrated: /\b(stupid|dumb|useless|bad|terrible|not helpful|doesn'?t understand|you don'?t understand|wrong answer|makes no sense)\b/,
  more: /^(more|tell me more|go on|continue|explain( more| further)?|details?|elaborate|expand|why|how|how so|example|examples|and( then)?|then what|what else|what next|next)\b[?!. ]*$/,
  time: /\b(what('s| is) the time|what time is it|current time|time now|the time\b)/,
  date: /\b(what('s| is) (the )?date|today'?s date|what day is (it|today))\b/,
  sun: /\b(sunrise|sunset|sun rise|sun set|day ?length|daylight|when does the sun)\b/,
};

function name(ctx: AssistantContext): string {
  return ctx.operator ? `, ${ctx.operator.split(/\s+/)[0]}` : '';
}

function timeGreeting(now: Date): string {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

// ── Unit conversion ─────────────────────────────────────────────────────

const UNITS: { re: RegExp; label: string; m2: number }[] = [
  { re: /^(ha|hectares?)$/, label: 'ha', m2: 10_000 },
  { re: /^(ac|acres?)$/, label: 'acres', m2: 4046.8564224 },
  { re: /^(km2|km²|sq ?km|square kilomet(er|re)s?)$/, label: 'km²', m2: 1_000_000 },
  { re: /^(m2|m²|sq ?m|square met(er|re)s?|sqm)$/, label: 'm²', m2: 1 },
  { re: /^(ft2|ft²|sq ?ft|square f(ee|oo)t|sqft)$/, label: 'sq ft', m2: 0.09290304 },
  { re: /^(mi2|sq ?mi|square miles?)$/, label: 'sq mi', m2: 2_589_988.110336 },
];
const UNIT_WORD = '(ha|hectares?|ac|acres?|km2|km²|sq ?km|square kilomet(?:er|re)s?|m2|m²|sq ?m|sqm|square met(?:er|re)s?|ft2|ft²|sq ?ft|sqft|square f(?:ee|oo)t|mi2|sq ?mi|square miles?)';

function findUnit(s: string) {
  const t = s.trim();
  return UNITS.find(u => u.re.test(t)) ?? null;
}

function convert(q: string): string | null {
  const text = normalize(q).replace(/,/g, '');
  let m = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${UNIT_WORD}\\s*(?:to|in|into|=|as)\\s*${UNIT_WORD}`).exec(text);
  let value: number;
  let from: (typeof UNITS)[number] | null;
  let to: (typeof UNITS)[number] | null;
  if (m) {
    value = Number(m[1]);
    from = findUnit(m[2]);
    to = findUnit(m[3]);
  } else {
    m = new RegExp(`how many\\s*${UNIT_WORD}\\s*(?:are )?(?:in|per|make)\\s*(?:an? |one )?(\\d+(?:\\.\\d+)?)?\\s*${UNIT_WORD}`).exec(text);
    if (!m) return null;
    to = findUnit(m[1]);
    value = m[2] ? Number(m[2]) : 1;
    from = findUnit(m[3]);
  }
  if (!from || !to || !Number.isFinite(value)) return null;
  const out = (value * from.m2) / to.m2;
  return `**${fmt(value, 6)} ${from.label} = ${fmt(out, 6)} ${to.label}**\n\n(1 ha = 10,000 m² = 2.4711 acres; 1 acre = 4,046.86 m².) Local units such as the bigha vary by state, so I don’t convert them.`;
}

// ── Topic matching ─────────────────────────────────────────────────────

interface Scored {
  topic: CompiledTopic;
  score: number;
}

export function scoreTopics(q: string): Scored[] {
  const qt = tokens(q);
  const norm = normalize(q);
  return COMPILED.map(topic => {
    let score = 0;
    for (const group of topic.compiled) {
      // Every token of a (possibly multi-word) keyword must match somewhere.
      let groupScore = Infinity;
      for (const { token, weight } of group) {
        let best = 0;
        for (const t of qt) best = Math.max(best, tokenMatch(t, token));
        groupScore = Math.min(groupScore, best * weight);
      }
      if (Number.isFinite(groupScore)) score += groupScore;
    }
    if (topic.phrases?.some(re => re.test(norm))) score += topic.phraseBoost ?? 3;
    return { topic, score };
  })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);
}

// ── Results lookup ─────────────────────────────────────────────────────

interface Row {
  label: string;
  value: string;
}

function tableRows(markdown: string): Row[] {
  const rows: Row[] = [];
  for (const line of markdown.split('\n')) {
    const m = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/.exec(line);
    if (!m || /^-+$/.test(m[1].replace(/\s/g, '')) || /^(statistic|measure|index|leg|year)$/i.test(m[1])) continue;
    rows.push({ label: m[1].replace(/\*\*/g, ''), value: m[2].replace(/\*\*/g, '') });
  }
  // Bullet lines "- Label: value" are results too.
  for (const line of markdown.split('\n')) {
    const m = /^-\s+([^:]{2,60}):\s+(.+)$/.exec(line);
    if (m && !/^(file|method|note)/i.test(m[1])) rows.push({ label: m[1], value: m[2] });
  }
  return rows;
}

function section(markdown: string, heading: string): string | null {
  const parts = markdown.split(/\n(?=## )/);
  const s = parts.find(p => p.startsWith(`## ${heading}`));
  return s ? s.replace(/^## [^\n]*\n+/, '').trim() : null;
}

function resultsAnswer(q: string, ctx: AssistantContext): AssistantReply | null {
  const r = ctx.results;
  if (!r) return null;
  const norm = normalize(q);
  const suggestions = ['Summarise the results', 'How was this calculated?', 'How reliable is this?'];

  if (/\b(summar|overview|results?|what did you find|findings|tell me about (it|this|the data)|explain (the )?(result|data|this))\b/.test(norm) && !/calculat|method/.test(norm)) {
    const res = section(r.markdown, 'Results');
    return { text: `Here’s what TerraX found for **${r.name}**:\n\n${res ?? r.markdown}`, suggestions, topic: 'results' };
  }
  if (/\b(how (was|is|were|did) (this|it|that|you)? ?(calculat|comput|measur|work)|method|formula|how accurate|accuracy|reliab|trust|limitation|caveat|uncertain)/.test(norm)) {
    const m = section(r.markdown, 'Method and limits');
    return { text: m ? `How it was computed, and its limits:\n\n${m}` : 'The method notes are in the report below the results.', suggestions: ['Summarise the results'], topic: 'results-method' };
  }

  // Dataset-specific statistics (tables).
  const ds = r.dataset;
  if (ds && ds.kind === 'table') {
    const cols = numericColumns(ds);
    const column = cols.find(c => norm.includes(c.toLowerCase())) ?? r.focus ?? cols[0];
    if (column) {
      const a = analyzeMetric(ds, column);
      const s = a.summary;
      if (s && a.points.length) {
        const maxPt = a.points.reduce((x, y) => (y.value > x.value ? y : x));
        const minPt = a.points.reduce((x, y) => (y.value < x.value ? y : x));
        if (/\b(trend|increas|decreas|chang|rising|falling|going up|going down|over time)\b/.test(norm)) {
          if (!a.trend) return { text: `There aren’t enough dated values in **${column}** for a trend test.`, suggestions, topic: 'results' };
          const verdict = a.trend.direction === 'no trend' ? 'shows **no statistically significant trend**' : `shows a **significant ${a.trend.direction} trend**`;
          return {
            text: `**${column}** ${verdict} (Mann–Kendall p = ${fmtP(a.trend.p)}), with a Theil–Sen slope of ${fmt(a.trend.senSlope)} per year from ${formatDate(a.start)} to ${formatDate(a.end)}.${a.trendCaveat ? `\n\nCaution: ${a.trendCaveat}` : ''}`,
            suggestions: ['What does the trend test mean?', 'Summarise the results'],
            topic: 'results',
          };
        }
        if (/\b(season|seasonal|month|months|monthly|monsoon)\b/.test(norm) && a.monthly?.length) {
          const valid = a.monthly.filter(m => Number.isFinite(m.mean));
          const hi = valid.reduce((x, y) => (y.mean > x.mean ? y : x));
          const lo = valid.reduce((x, y) => (y.mean < x.mean ? y : x));
          return { text: `Seasonal cycle of **${column}**: highest in **${hi.label}** (mean ${fmt(hi.mean)}), lowest in **${lo.label}** (${fmt(lo.mean)}).`, suggestions, topic: 'results' };
        }
        if (/\b(max|maximum|highest|peak|largest|biggest|wettest|hottest|most)\b/.test(norm)) return { text: `The highest **${column}** is **${fmt(maxPt.value)}** on ${maxPt.label}.`, suggestions, topic: 'results' };
        if (/\b(min|minimum|lowest|smallest|least|driest|coldest)\b/.test(norm)) return { text: `The lowest **${column}** is **${fmt(minPt.value)}** on ${minPt.label}.`, suggestions, topic: 'results' };
        if (/\b(mean|average|avg|typical|median)\b/.test(norm)) return { text: `**${column}**: mean ${fmt(s.mean)} ± ${fmt(s.sd)} (SD), median ${fmt(s.median)}, from ${s.n} values.`, suggestions, topic: 'results' };
        if (/\b(how many|count|number of|records|rows|values)\b/.test(norm)) return { text: `The file has ${ds.rows.length} rows; **${column}** has ${s.n} numeric values${ds.times ? ` from ${formatDate(a.start)} to ${formatDate(a.end)}` : ''}.`, suggestions, topic: 'results' };
      }
    }
  }

  // Match the question against result rows (e.g. "how much forest was lost?" → "Forest loss").
  const qt = tokens(q);
  if (qt.length) {
    let best: { row: Row; score: number } | null = null;
    for (const row of tableRows(r.markdown)) {
      const lt = tokens(row.label.replace(/\([^)]*\)/g, ' '));
      if (!lt.length) continue;
      let hit = 0;
      for (const l of lt) {
        let m = 0;
        for (const t of qt) m = Math.max(m, tokenMatch(t, l));
        hit += m;
      }
      const score = hit / Math.max(lt.length, 1) + hit * 0.1;
      if (!best || score > best.score) best = { row, score };
    }
    if (best && best.score >= 0.75) return { text: `**${best.row.label}:** ${best.row.value}`, suggestions, topic: 'results' };
  }
  return null;
}

// ── Engine ─────────────────────────────────────────────────────────────

export class OfflineAssistant {
  private lastTopic: string | null = null;
  private pending: string | null = null;
  /** Whether the detailed answer for lastTopic was already given. */
  private gaveMore = false;

  constructor(private readonly mode: 'guide' | 'results') {}

  reset() {
    this.lastTopic = null;
    this.pending = null;
  }

  private topicReply(t: CompiledTopic, prefix = ''): AssistantReply {
    this.lastTopic = t.id;
    this.pending = t.more ?? null;
    this.gaveMore = false;
    const offer = t.more ? '\n\nWant more detail? Just say **yes** or ask a follow-up.' : '';
    return { text: `${prefix}${t.answer}${offer}`, suggestions: t.suggestions ?? STARTER_SUGGESTIONS, topic: t.id };
  }

  reply(question: string, ctx: AssistantContext): AssistantReply {
    const now = ctx.now ?? new Date();
    const norm = normalize(question);
    const wordCount = words(question).length;
    const hasTopic = scoreTopics(question)[0]?.score >= 2;

    if (!norm) return { text: 'Ask me anything about TerraX or your data.', suggestions: STARTER_SUGGESTIONS };

    // 1. Short conversational turns.
    if (RE.yes.test(norm)) {
      if (this.pending) {
        const text = this.pending;
        this.pending = null;
        this.gaveMore = true;
        return { text, suggestions: byId.get(this.lastTopic ?? '')?.suggestions ?? STARTER_SUGGESTIONS, topic: this.lastTopic ?? undefined };
      }
      return { text: 'Great. What would you like to do? Pick a tool below or ask a question.', suggestions: STARTER_SUGGESTIONS };
    }
    if (RE.no.test(norm)) {
      this.pending = null;
      return { text: 'No problem. Ask whenever you need something.', suggestions: STARTER_SUGGESTIONS };
    }
    if (RE.greet.test(norm) && wordCount <= 5 && !hasTopic) {
      const results = this.mode === 'results' && ctx.results ? ` I can see your **${ctx.results.toolName}** results for ${ctx.results.name}; ask me about them.` : '';
      return {
        text: `${timeGreeting(now)}${name(ctx)}! I’m the TerraX assistant.${results || ' I can walk you through the tools, explain remote-sensing terms, convert area units and tell you sunrise times.'} What would you like to do?`,
        suggestions: this.mode === 'results' && ctx.results ? ['Summarise the results', 'How was this calculated?', 'How reliable is this?'] : STARTER_SUGGESTIONS,
      };
    }
    if (RE.howAreYou.test(norm) && !hasTopic) {
      return { text: `I’m running smoothly, thanks for asking${name(ctx)}! Ready to help with forest, land, climate or imagery analysis. What are you working on?`, suggestions: STARTER_SUGGESTIONS };
    }
    if (RE.whoAreYou.test(norm)) {
      return {
        text: 'I’m **TerraX’s built-in assistant**. I run entirely in your browser, so I work offline: I recognise questions about the tools, remote-sensing and GIS terms, area units, sun times and your current results. I’m not a general AI model; for open-ended questions, add a Gemini API key in Settings.',
        suggestions: ['What can you do?', 'How do I set up AI?'],
      };
    }
    if (RE.capabilities.test(norm) && !hasTopic) {
      return {
        text:
          'Here’s what I can help with, even offline:\n\n- **Tools:** forest loss, carbon & biomass, land survey (upload or draw a plot), weather & climate, satellite imagery, terrain, photos\n- **Explain terms:** NDVI, EVI, NDWI, NBR, UTM/CRS, Mann–Kendall trends, IMD rainfall categories, hypsometric integral…\n- **Your results:** “summarise the results”, “what is the peak?”, “is there a trend?”\n- **Quick answers:** “convert 3 acres to hectares”, “when is sunrise?”, “what time is it?”\n- **Troubleshooting** upload errors\n\nJust ask in your own words.',
        suggestions: STARTER_SUGGESTIONS.slice(1),
      };
    }
    if (RE.thanks.test(norm) && wordCount <= 6) {
      return { text: `You’re welcome${name(ctx)}! Anything else I can help with?`, suggestions: byId.get(this.lastTopic ?? '')?.suggestions ?? STARTER_SUGGESTIONS };
    }
    if (RE.praise.test(norm) && wordCount <= 5) {
      return { text: 'Glad that helped! What’s next?', suggestions: byId.get(this.lastTopic ?? '')?.suggestions ?? STARTER_SUGGESTIONS };
    }
    if (RE.bye.test(norm) && wordCount <= 5) {
      return { text: `Goodbye${name(ctx)}! Your saved reports stay in the Reports tab. Come back any time.`, suggestions: [] };
    }
    if (RE.frustrated.test(norm) && !hasTopic) {
      return {
        text: 'Sorry about that. I’m a built-in offline assistant, so I work best with specific questions, such as “how do I measure a plot?”, “what is NDVI?” or “summarise the results”. For free-form conversation, turn on AI in Settings with a Gemini API key.',
        suggestions: ['What can you do?', 'How do I set up AI?'],
      };
    }

    // 2. Live answers.
    const conversion = convert(question);
    if (conversion) return { text: conversion, suggestions: ['How do I measure a plot?'], topic: 'units' };
    if (RE.time.test(norm)) {
      const s = solarReport(now, ctx.target.lat, ctx.target.lon);
      return {
        text: `It’s **${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}** on your device (${now.toISOString().slice(11, 16)} UTC). At ${ctx.target.name}, local mean solar time is ${formatClock(s.meanSolarTime).slice(0, 5)}.`,
        suggestions: ['When is sunrise?', 'What is solar time?'],
      };
    }
    if (RE.date.test(norm)) {
      return { text: `Today is **${now.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}**.`, suggestions: STARTER_SUGGESTIONS };
    }
    if (RE.sun.test(norm)) {
      const s = solarReport(now, ctx.target.lat, ctx.target.lon);
      const t = (d: Date | null) => {
        if (!d) return 'none today (polar day or night)';
        const day = d.toDateString() === now.toDateString() ? '' : `${d.toLocaleDateString([], { weekday: 'short' })} `;
        return `${day}${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} your time (${d.toISOString().slice(11, 16)} UTC)`;
      };
      const mins = s.sunrise && s.sunset ? Math.round((s.sunset.getTime() - s.sunrise.getTime()) / 60_000) : null;
      return {
        text: `At **${ctx.target.name}** today:\n\n- Sunrise: ${t(s.sunrise)}\n- Sunset: ${t(s.sunset)}${mins !== null ? `\n- Day length: ${Math.floor(mins / 60)} h ${mins % 60} min` : ''}\n- Sun now: ${Math.abs(s.altitude).toFixed(1)}° ${s.altitude >= 0 ? 'above' : 'below'} the horizon\n\nChange the location in Settings → Telemetry target.`,
        suggestions: ['What does the telemetry panel show?'],
        topic: 'sun',
      };
    }

    // 3. Questions about the current results (results assistant). Definition
    // questions ("what is NDVI?") go to the glossary instead.
    const definitional = /^(what (is|are|does)( an?| the)?|define|definition of|meaning of|what do you mean by|explain( what)?)\b/.test(norm);
    const strongTopic = (scoreTopics(question)[0]?.score ?? 0) >= 3;
    if (this.mode === 'results' && !(definitional && strongTopic)) {
      const r = resultsAnswer(question, ctx);
      if (r) {
        this.lastTopic = r.topic ?? null;
        this.pending = null;
        return r;
      }
    }

    // 4. Follow-ups on the previous topic.
    const scored = scoreTopics(question);
    const top = scored[0];
    if (RE.more.test(norm) && (!top || top.score < 2) && this.lastTopic) {
      const t = byId.get(this.lastTopic);
      if (t?.more && !this.gaveMore) {
        this.pending = null;
        this.gaveMore = true;
        return { text: t.more, suggestions: t.suggestions ?? STARTER_SUGGESTIONS, topic: t.id };
      }
      if (t) return { text: `That’s the main point about **${t.title.toLowerCase()}**. Related questions:`, suggestions: t.suggestions ?? STARTER_SUGGESTIONS, topic: t.id };
    }

    // 5. Knowledge topics.
    if (top && top.score >= 2) {
      const second = scored[1];
      // Two strong, distinct matches: answer the best and point to the other.
      const also = second && second.score >= 2 && second.score >= top.score * 0.8 ? `\n\n_Also related: ${second.topic.title.toLowerCase()}. Ask if you want that too._` : '';
      const r = this.topicReply(top.topic);
      return { ...r, text: r.text + also };
    }
    if (top && top.score >= 1) {
      const options = scored.slice(0, 3).map(s => s.topic.title);
      return {
        text: `I’m not completely sure what you mean. Did you mean one of these?`,
        suggestions: options,
      };
    }

    // 6. Nothing matched.
    return {
      text:
        this.mode === 'results' && ctx.results
          ? `I couldn’t match that to these results. Try “summarise the results”, “how was this calculated?” or ask about a specific value${ctx.results.dataset ? ', such as the peak, mean or trend' : ''}. For open-ended questions, turn on AI in Settings.`
          : 'I didn’t catch that. I understand questions about TerraX’s tools, remote-sensing terms, area units and sun times. Try one of these, or turn on AI in Settings for open-ended questions.',
      suggestions: this.mode === 'results' ? ['Summarise the results', 'How was this calculated?', 'What can you do?'] : STARTER_SUGGESTIONS,
    };
  }
}

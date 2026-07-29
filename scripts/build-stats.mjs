#!/usr/bin/env node
/**
 * Regenerates the stats block in README.md from the GitHub GraphQL API.
 *
 * Why this exists instead of a third-party card service:
 * `contributionsCollection.totalCommitContributions` NEVER includes private
 * repo commits — not even when queried with the account owner's own token.
 * Those live in `restrictedContributionsCount`, which any token can read once
 * the account shares private contribution counts. The card services simply
 * never query it, so they report ~7% of the real number. We sum both fields.
 *
 * Two independent blocks, because only one of them needs elevated access:
 *   STATS — contribution counts and streaks. Works with a plain GITHUB_TOKEN.
 *   REPOS — repo count and languages. Needs a PAT to see private repos, and is
 *           left untouched when the token cannot, rather than downgraded.
 *
 * Usage: GH_TOKEN=<token> node scripts/build-stats.mjs
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const LOGIN = process.env.STATS_LOGIN || 'AnowarDotDev';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = join(ROOT, 'README.md');
const ASSETS = join(ROOT, 'assets');
const START = '<!-- STATS:START -->';
const END = '<!-- STATS:END -->';
const REPOS_START = '<!-- REPOS:START -->';
const REPOS_END = '<!-- REPOS:END -->';

if (!TOKEN) {
    console.error('Missing GH_TOKEN / GITHUB_TOKEN.');
    process.exit(1);
}

async function graphql(query, variables = {}) {
    const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
            Authorization: `bearer ${TOKEN}`,
            'Content-Type': 'application/json',
            'User-Agent': `${LOGIN}-profile-stats`,
        },
        body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);

    const body = await res.json();
    if (body.errors?.length) throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);

    return body.data;
}

/** Profile basics + contribution years to iterate over. */
async function fetchProfile() {
    const data = await graphql(
        `query ($login: String!) {
            user(login: $login) {
                createdAt
                followers { totalCount }
                contributionsCollection { contributionYears }
            }
        }`,
        { login: LOGIN },
    );

    return data.user;
}

/**
 * Per-year counters. Kept separate from the calendar query on purpose —
 * GitHub's cost estimator rejects the combined query ("Resource limits for
 * this query exceeded") once restrictedContributionsCount is in the mix.
 */
async function fetchYearCounts(year) {
    const data = await graphql(
        `query ($login: String!, $from: DateTime!, $to: DateTime!) {
            user(login: $login) {
                contributionsCollection(from: $from, to: $to) {
                    totalCommitContributions
                    restrictedContributionsCount
                    totalPullRequestContributions
                    totalPullRequestReviewContributions
                    totalIssueContributions
                    totalRepositoryContributions
                }
            }
        }`,
        { login: LOGIN, from: `${year}-01-01T00:00:00Z`, to: `${year}-12-31T23:59:59Z` },
    );

    return data.user.contributionsCollection;
}

/** Day-level calendar for the year, used for streaks and the totals bar. */
async function fetchYearCalendar(year) {
    const data = await graphql(
        `query ($login: String!, $from: DateTime!, $to: DateTime!) {
            user(login: $login) {
                contributionsCollection(from: $from, to: $to) {
                    contributionCalendar {
                        totalContributions
                        weeks { contributionDays { date contributionCount } }
                    }
                }
            }
        }`,
        { login: LOGIN, from: `${year}-01-01T00:00:00Z`, to: `${year}-12-31T23:59:59Z` },
    );

    const calendar = data.user.contributionsCollection.contributionCalendar;

    return {
        total: calendar.totalContributions,
        days: calendar.weeks.flatMap((w) => w.contributionDays),
    };
}

/**
 * Every repo we own (public AND private, forks excluded), for stars and the
 * language breakdown. Counted by primary language per repo rather than bytes —
 * byte share is dominated by committed build output and skews wildly.
 */
async function fetchRepos() {
    const repos = [];
    let cursor = null;

    do {
        const data = await graphql(
            `query ($login: String!, $cursor: String) {
                user(login: $login) {
                    repositories(first: 50, ownerAffiliations: OWNER, isFork: false, after: $cursor) {
                        pageInfo { hasNextPage endCursor }
                        nodes {
                            isPrivate
                            stargazerCount
                            primaryLanguage { name color }
                        }
                    }
                }
            }`,
            { login: LOGIN, cursor },
        );

        const page = data.user.repositories;
        repos.push(...page.nodes);
        cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);

    return repos;
}

/** Longest and current run of consecutive days with at least one contribution. */
function calcStreaks(days) {
    const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
    const today = new Date().toISOString().slice(0, 10);

    let longest = 0;
    let run = 0;

    for (const day of sorted) {
        if (day.date > today) break;
        run = day.contributionCount > 0 ? run + 1 : 0;
        longest = Math.max(longest, run);
    }

    // A blank today is not a broken streak yet — the day isn't over.
    let current = 0;
    for (let i = sorted.length - 1; i >= 0; i--) {
        const day = sorted[i];
        if (day.date > today) continue;
        if (day.contributionCount === 0) {
            if (day.date === today) continue;
            break;
        }
        current++;
    }

    return { longest, current };
}

const num = (n) => n.toLocaleString('en-US');

/** shields.io escaping: literal dashes and underscores must be doubled. */
const shield = (label, message, color, extra = '') => {
    const esc = (s) => encodeURIComponent(String(s).replace(/-/g, '--').replace(/_/g, '__'));

    return `https://img.shields.io/badge/${esc(label)}-${esc(message)}-${color}?style=for-the-badge${extra}`;
};

// ---------------------------------------------------------------------------
// SVG bar charts
//
// One hue, not GitHub's language colors: run through the palette validator those
// fail hard — #f1e05a (JavaScript) sits at 1.35:1 on a white surface and #4F5D95
// (PHP) reads as gray. Every row is directly labelled anyway, so colour was only
// ever decoration here. Blue #2a78d6 / #3987e5 passes every check on both the
// light (#ffffff) and dark (#0d1117) README surfaces.
// ---------------------------------------------------------------------------

const THEMES = {
    // Ink and rule colours are GitHub's own, so the charts sit in the README
    // rather than on top of it.
    light: { ink: '#1f2328', muted: '#656d76', rule: '#d0d7de', bar: '#2a78d6' },
    dark: { ink: '#e6edf3', muted: '#8b949e', rule: '#30363d', bar: '#3987e5' },
};

const CHART = {
    padX: 4,
    labelWidth: 96,
    gap: 14,
    plotWidth: 520,
    valueGap: 8,
    valueWidth: 56,
    rowHeight: 28,
    padY: 12,
    thickness: 13,
    radius: 4,
};

const escapeXml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

/** Bar grows from the baseline: square where it starts, 4px rounded at the data end. */
function barPath(x, y, width, height, radius) {
    const r = Math.min(radius, width, height / 2);
    const n = (v) => Number(v.toFixed(2));

    return `M${x} ${y}h${n(width - r)}a${r} ${r} 0 0 1 ${r} ${r}v${n(height - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${r}H${x}z`;
}

/**
 * Horizontal bars, one row per item. No gridlines and no track — every value is
 * directly labelled, and direct labels come before gridlines.
 */
function chartSvg(rows, { title, theme }) {
    const t = THEMES[theme];
    const c = CHART;
    const x0 = c.padX + c.labelWidth + c.gap;
    const width = x0 + c.plotWidth + c.valueGap + c.valueWidth + c.padX;
    const height = c.padY * 2 + rows.length * c.rowHeight;
    const peak = Math.max(...rows.map((r) => r.value), 1);

    const marks = rows
        .map((row, i) => {
            const y = c.padY + i * c.rowHeight;
            const midY = y + c.rowHeight / 2;
            const barY = midY - c.thickness / 2;
            // A non-zero value never renders as nothing, so 20 beside 4,037 still reads.
            const barW = row.value > 0 ? Math.max(c.radius + 1, (row.value / peak) * c.plotWidth) : 0;

            // The value rides its own bar's tip rather than sitting in a
            // right-pinned column, where a long gap detaches it from the mark.
            const valueX = Number((x0 + barW + c.valueGap).toFixed(2));

            return [
                `    <text x="${x0 - c.gap}" y="${midY}" fill="${t.ink}" text-anchor="end" dominant-baseline="central">${escapeXml(row.label)}</text>`,
                barW > 0 ? `    <path d="${barPath(x0, barY, barW, c.thickness, c.radius)}" fill="${t.bar}"/>` : '',
                `    <text x="${valueX}" y="${midY}" fill="${t.muted}" dominant-baseline="central">${escapeXml(row.display)}</text>`,
            ]
                .filter(Boolean)
                .join('\n');
        })
        .join('\n');

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">
  <title>${escapeXml(title)}</title>
  <g font-family="system-ui,-apple-system,'Segoe UI',sans-serif" font-size="13">
    <line x1="${x0 - 0.5}" y1="${c.padY}" x2="${x0 - 0.5}" y2="${height - c.padY}" stroke="${t.rule}" stroke-width="1"/>
${marks}
  </g>
</svg>
`;
}

/** Writes both theme variants and returns the <picture> markup for the README. */
function writeChart(name, rows, { title, alt }) {
    mkdirSync(ASSETS, { recursive: true });

    for (const theme of ['light', 'dark']) {
        writeFileSync(join(ASSETS, `${name}-${theme}.svg`), chartSvg(rows, { title, theme }));
    }

    // Cache-buster: GitHub proxies README images through camo, which would keep
    // serving yesterday's chart from an unchanged URL.
    const v = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    return `<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/${name}-dark.svg?v=${v}">
  <img alt="${escapeXml(alt)}" src="assets/${name}-light.svg?v=${v}">
</picture>`;
}

/** Numbers stay reachable for screen readers and search, not only in the image. */
function tableView(rows, [labelHead, valueHead]) {
    const body = rows.map((r) => `| ${r.label} | ${r.display} |`).join('\n');

    return `<details>
<summary><sub>Table view</sub></summary>

| ${labelHead} | ${valueHead} |
| --- | --- |
${body}

</details>`;
}

function render({ profile, counts, calendars, repos, streaks }) {
    const commits = counts.reduce((n, c) => n + c.totalCommitContributions + c.restrictedContributionsCount, 0);
    const prs = counts.reduce((n, c) => n + c.totalPullRequestContributions, 0);
    const reviews = counts.reduce((n, c) => n + c.totalPullRequestReviewContributions, 0);
    const issues = counts.reduce((n, c) => n + c.totalIssueContributions, 0);
    const contributions = calendars.reduce((n, c) => n + c.total, 0);
    const since = new Date(profile.createdAt).getUTCFullYear();

    // A badge reading "0" is worse than no badge, so anything empty is dropped.
    const badges = [
        ['Commits', commits, '', '0f172a', '&logo=git&logoColor=white'],
        ['Contributions', contributions, '', '1f6feb', '&logo=github&logoColor=white'],
        ['Pull requests', prs, '', '8250df', '&logo=github&logoColor=white'],
        ['Code reviews', reviews, '', '0969da', '&logo=github&logoColor=white'],
        ['Issues', issues, '', '0969da', '&logo=github&logoColor=white'],
        ['Current streak', streaks.current, ' days', 'd29922', '&logo=fire&logoColor=white'],
        ['Longest streak', streaks.longest, ' days', 'cf222e', '&logo=fire&logoColor=white'],
    ]
        .filter(([, value]) => value >= 2)
        .map(
            ([label, value, suffix, color, extra]) =>
                `<img alt="${label}" src="${shield(label, num(value) + suffix, color, extra)}">`,
        )
        // One source line, or GitHub renders each badge on its own row and the
        // centred result reads as a staircase instead of a wrapped strip.
        .join(' ');

    const rows = calendars
        .filter((c) => c.total > 0)
        .sort((a, b) => b.year - a.year)
        .map((c) => ({ label: String(c.year), value: c.total, display: num(c.total) }));

    const title = `Contributions per year, ${since}–${rows[0]?.label ?? since}`;
    const chart = writeChart('contributions', rows, {
        title,
        alt: `${title}: ${rows.map((r) => `${r.label} ${r.display}`).join(', ')}`,
    });

    const updated = new Date().toISOString().slice(0, 10);
    const followers = profile.followers.totalCount;

    return `<div align="center">

${badges}

</div>

**Contributions per year** — public and private combined, since ${since}

${chart}

${tableView(rows, ['Year', 'Contributions'])}

<div align="center"><sub>${followers > 0 ? `👥 ${num(followers)} followers · ` : ''}generated ${updated} by <a href="scripts/build-stats.mjs">build-stats.mjs</a></sub></div>`;
}

/**
 * Repo counts and languages. Split into its own block because this is the only
 * part that needs a PAT — GITHUB_TOKEN sees no private repos, and rewriting the
 * block with public-only data would silently downgrade correct numbers.
 */
function renderRepos({ repos }) {
    const stars = repos.reduce((n, r) => n + r.stargazerCount, 0);

    // Counted by primary language per repo, not byte share: committed build
    // output pushes byte share to 60% JavaScript and misrepresents the work.
    const byLang = new Map();
    for (const repo of repos) {
        if (!repo.primaryLanguage) continue;
        byLang.set(repo.primaryLanguage.name, (byLang.get(repo.primaryLanguage.name) ?? 0) + 1);
    }

    const langTotal = [...byLang.values()].reduce((a, b) => a + b, 0) || 1;
    const ranked = [...byLang.entries()].sort((a, b) => b[1] - a[1]);
    const shown = ranked.slice(0, 8);
    const rows = shown.map(([name, count]) => ({
        label: name,
        value: count,
        display: `${((100 * count) / langTotal).toFixed(1)}%`,
    }));

    const title = 'Repositories by primary language';
    const chart = writeChart('languages', rows, {
        title,
        alt: `${title}: ${rows.map((r) => `${r.label} ${r.display}`).join(', ')}`,
    });

    // Never imply the chart is the whole list when it is a top-8 cut.
    const hidden = ranked.length - shown.length;
    const note = hidden > 0 ? `, top ${shown.length} of ${ranked.length}` : '';

    const repoBadge = `<img alt="Repositories" src="${shield('Repositories', num(repos.length), '57606a', '&logo=github&logoColor=white')}">`;
    const starBadge =
        stars > 0 ? ` <img alt="Stars" src="${shield('Stars', num(stars), 'd29922', '&logo=github&logoColor=white')}">` : '';

    return `<div align="center">

${repoBadge}${starBadge}

</div>

**Repositories by primary language** — ${repos.length} owned repos, forks excluded${note}

${chart}

${tableView(rows, ['Language', 'Share'])}`;
}

/**
 * Commit totals only ever go up, so a drop means the token saw less than the
 * last run did — a weaker token must never overwrite a stronger run's numbers.
 */
function previousCommits(readme) {
    const match = readme.match(/badge\/Commits-([\d%C,]+)-/);

    return match ? Number(decodeURIComponent(match[1]).replace(/,/g, '')) : 0;
}

/** Swaps the text between a marker pair, leaving the markers in place. */
function replaceBlock(source, start, end, content) {
    const startAt = source.indexOf(start);
    const endAt = source.indexOf(end);

    if (startAt === -1 || endAt === -1 || endAt < startAt) {
        throw new Error(`README.md is missing the ${start} / ${end} markers.`);
    }

    return `${source.slice(0, startAt + start.length)}\n\n${content}\n\n${source.slice(endAt)}`;
}

const profile = await fetchProfile();
const years = [...profile.contributionsCollection.contributionYears].sort();

const counts = [];
const calendars = [];

// Sequential on purpose: GitHub throttles bursts of expensive GraphQL queries.
for (const year of years) {
    counts.push(await fetchYearCounts(year));
    calendars.push({ year, ...(await fetchYearCalendar(year)) });
}

const repos = await fetchRepos();
const streaks = calcStreaks(calendars.flatMap((c) => c.days));
const readme = readFileSync(README, 'utf8');

const commits = counts.reduce((n, c) => n + c.totalCommitContributions + c.restrictedContributionsCount, 0);
const private_ = counts.reduce((n, c) => n + c.restrictedContributionsCount, 0);
const before = previousCommits(readme);

console.log(`Commits: ${commits.toLocaleString('en-US')} (${private_.toLocaleString('en-US')} private), was ${before.toLocaleString('en-US')}`);

let next = readme;

if (commits >= before) {
    next = replaceBlock(next, START, END, render({ profile, counts, calendars, streaks }));
} else {
    console.log(
        `::warning::This token sees ${commits.toLocaleString('en-US')} commits but the README already shows ` +
            `${before.toLocaleString('en-US')} — stats block left unchanged rather than downgraded. ` +
            `restrictedContributionsCount came back as ${private_.toLocaleString('en-US')}.`,
    );
}

// Only a PAT can see private repos. Without one the counts would drop from 49
// to 27 and the languages would shift, so the block is left as it was.
if (repos.some((r) => r.isPrivate)) {
    next = replaceBlock(next, REPOS_START, REPOS_END, renderRepos({ repos }));
    console.log(`Repos: ${repos.length} (${repos.filter((r) => r.isPrivate).length} private) — repo block rewritten.`);
} else {
    console.log(`Repos: only ${repos.length} public visible — repo block left unchanged (needs STATS_TOKEN).`);
}

if (next === readme) {
    console.log('Stats unchanged.');
    process.exit(0);
}

writeFileSync(README, next);
console.log('README.md updated.');

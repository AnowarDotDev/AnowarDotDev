#!/usr/bin/env node
/**
 * Regenerates the stats block in README.md from the GitHub GraphQL API.
 *
 * Why this exists instead of a third-party card service:
 * `contributionsCollection.totalCommitContributions` NEVER includes private
 * repo commits — not even when queried with the account owner's own token.
 * Those live in `restrictedContributionsCount`, so any service using someone
 * else's token reports ~7% of the real number. We sum both fields ourselves.
 *
 * Usage: GH_TOKEN=<pat with read:user + repo> node scripts/build-stats.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const LOGIN = process.env.STATS_LOGIN || 'AnowarDotDev';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const README = join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md');
const START = '<!-- STATS:START -->';
const END = '<!-- STATS:END -->';

if (!TOKEN) {
    console.error('Missing GH_TOKEN. Needs a PAT with read:user + repo scope.');
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

function bar(fraction, width = 20) {
    const filled = Math.max(fraction > 0 ? 1 : 0, Math.round(fraction * width));

    return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

function render({ profile, counts, calendars, repos, streaks }) {
    const commits = counts.reduce((n, c) => n + c.totalCommitContributions + c.restrictedContributionsCount, 0);
    const prs = counts.reduce((n, c) => n + c.totalPullRequestContributions, 0);
    const reviews = counts.reduce((n, c) => n + c.totalPullRequestReviewContributions, 0);
    const issues = counts.reduce((n, c) => n + c.totalIssueContributions, 0);
    const contributions = calendars.reduce((n, c) => n + c.total, 0);
    const stars = repos.reduce((n, r) => n + r.stargazerCount, 0);
    const since = new Date(profile.createdAt).getUTCFullYear();

    // A badge reading "0" is worse than no badge, so anything empty is dropped.
    const badges = [
        ['Commits', commits, '', '0f172a', '&logo=git&logoColor=white'],
        ['Contributions', contributions, '', '1f6feb', '&logo=github&logoColor=white'],
        ['Pull requests', prs, '', '8250df', '&logo=github&logoColor=white'],
        ['Code reviews', reviews, '', '0969da', '&logo=github&logoColor=white'],
        ['Issues', issues, '', '0969da', '&logo=github&logoColor=white'],
        ['Repositories', repos.length, '', '57606a', '&logo=github&logoColor=white'],
        ['Current streak', streaks.current, ' days', 'd29922', '&logo=fire&logoColor=white'],
        ['Longest streak', streaks.longest, ' days', 'cf222e', '&logo=fire&logoColor=white'],
    ]
        .filter(([, value]) => value >= 2)
        .map(
            ([label, value, suffix, color, extra]) =>
                `<img alt="${label}" src="${shield(label, num(value) + suffix, color, extra)}">`,
        )
        .join('\n');

    // Contributions per year, newest first.
    const years = calendars
        .map((c) => c)
        .sort((a, b) => b.year - a.year)
        .filter((c) => c.total > 0);
    const peak = Math.max(...years.map((c) => c.total), 1);
    const yearRows = years
        .map((c) => `${c.year}  ${bar(c.total / peak, 24)}  ${String(num(c.total)).padStart(6)}`)
        .join('\n');

    // Repos by primary language — byte share is skewed by committed build output.
    const byLang = new Map();
    for (const repo of repos) {
        if (!repo.primaryLanguage) continue;
        byLang.set(repo.primaryLanguage.name, (byLang.get(repo.primaryLanguage.name) ?? 0) + 1);
    }
    const langTotal = [...byLang.values()].reduce((a, b) => a + b, 0) || 1;
    const langRows = [...byLang.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, count]) => {
            const pct = (100 * count) / langTotal;

            return `${name.padEnd(12)}  ${bar(count / langTotal, 20)}  ${pct.toFixed(1).padStart(5)}%`;
        })
        .join('\n');

    const updated = new Date().toISOString().slice(0, 10);
    const footer = [
        stars > 0 ? `⭐ ${num(stars)} stars` : null,
        profile.followers.totalCount > 0 ? `👥 ${num(profile.followers.totalCount)} followers` : null,
        `generated ${updated} by <a href="scripts/build-stats.mjs">build-stats.mjs</a>`,
    ]
        .filter(Boolean)
        .join(' · ');

    return `<div align="center">

${badges}

</div>

**Contributions per year** — public and private combined, since ${since}

\`\`\`text
${yearRows}
\`\`\`

**Repositories by primary language** — ${repos.length} owned repos, forks excluded

\`\`\`text
${langRows}
\`\`\`

<div align="center"><sub>${footer}</sub></div>`;
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
const block = render({ profile, counts, calendars, repos, streaks });

const readme = readFileSync(README, 'utf8');
const startAt = readme.indexOf(START);
const endAt = readme.indexOf(END);

if (startAt === -1 || endAt === -1) {
    console.error(`README.md is missing the ${START} / ${END} markers.`);
    process.exit(1);
}

const next = `${readme.slice(0, startAt + START.length)}\n\n${block}\n\n${readme.slice(endAt)}`;

if (next === readme) {
    console.log('Stats unchanged.');
    process.exit(0);
}

writeFileSync(README, next);
console.log('README.md stats block updated.');

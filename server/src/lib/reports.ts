// User-filed reports: the vocabulary, the validation, and the presentation
// shared with the moderation UI.
//
// Kept free of Prisma and Express so the rules can be unit-tested directly —
// the route file owns the queries, this owns what counts as a valid report.

export const REPORT_CATEGORIES = {
  spam: 'Spam or scam',
  harassment: 'Harassment or bullying',
  hate: 'Hate speech',
  sexual: 'Sexual content',
  violence: 'Violence or threats',
  other: 'Something else',
} as const;

export type ReportCategory = keyof typeof REPORT_CATEGORIES;

export const CATEGORY_KEYS = Object.keys(REPORT_CATEGORIES) as ReportCategory[];

export function isReportCategory(v: unknown): v is ReportCategory {
  return typeof v === 'string' && v in REPORT_CATEGORIES;
}

export function categoryLabel(category: string): string {
  // A row written by an older build must still render legibly after a rename
  return REPORT_CATEGORIES[category as ReportCategory] ?? category;
}

export type ReportTargetType = 'comment' | 'blogPost' | 'user';

export function isReportTargetType(v: unknown): v is ReportTargetType {
  return v === 'comment' || v === 'blogPost' || v === 'user';
}

export type ReportStatus = 'open' | 'resolved' | 'dismissed';

// Only two ways out of the queue, and neither returns to it. Reopening would
// make "how many open reports" a number that can go up without anyone filing
// anything, which is not a question worth answering.
export function isResolution(v: unknown): v is 'resolved' | 'dismissed' {
  return v === 'resolved' || v === 'dismissed';
}

export const MAX_REPORT_NOTE = 1000;
// What the moderator sees inline. Long enough to judge most comments without
// opening anything, short enough that the queue stays scannable.
export const REPORT_SNAPSHOT_CHARS = 600;

// 'other' says nothing on its own, so it has to be explained. Every other
// category carries its own meaning and the note stays optional.
export function noteRequiredFor(category: ReportCategory): boolean {
  return category === 'other';
}

export interface ReportInputCheck {
  ok: boolean;
  error?: string;
  note: string;
}

// Validates the reporter-supplied half of a report. The target half (what is
// being reported, and by whom) is resolved from the database by the route, not
// taken from the client.
export function checkReportInput(category: unknown, note: unknown): ReportInputCheck {
  if (!isReportCategory(category)) {
    return { ok: false, error: 'Choose a reason for this report', note: '' };
  }
  if (note !== undefined && note !== null && typeof note !== 'string') {
    return { ok: false, error: 'note must be a string', note: '' };
  }
  const text = typeof note === 'string' ? note.trim() : '';
  if (text.length > MAX_REPORT_NOTE) {
    return { ok: false, error: `Keep the details under ${MAX_REPORT_NOTE.toLocaleString()} characters`, note: '' };
  }
  if (noteRequiredFor(category) && !text) {
    return { ok: false, error: 'Tell us what’s wrong so a moderator can act on it', note: '' };
  }
  return { ok: true, note: text };
}

"use client";

import type { SasPhrase } from "@/lib/sas";

// Verification lifecycle, owned by page.tsx (single source of truth) and passed
// down to both the chat header and the video scrim so the two surfaces always
// agree. ADVISORY only — never blocks chat or video (stakeholder ruling).
//   pending     — fingerprints not derived yet (channel just opened)
//   unverified  — phrase shown, awaiting the human's "they match" judgement
//   verified    — the human confirmed both screens show the same phrase
//   flagged     — the human declared a mismatch → loud, persistent warning
//   unavailable — TERMINAL: derivation failed after retries (deriveSAS threw or
//                 fingerprints never arrived). No phrase will ever appear. NOT a
//                 positive/verified assurance — chat still works, but unverified.
export type SasStatus =
  | "pending"
  | "unverified"
  | "verified"
  | "flagged"
  | "unavailable";

export interface SafetyPhraseProps {
  phrase: SasPhrase | null;
  status: SasStatus;
  onConfirmMatch: () => void;
  onFlagMismatch: () => void;
}

// Shared copy constants. Centralised here so the chat header and the video
// scrim can never drift in wording. Token count is deliberately NOT baked into
// any of these strings (the phrase length is variable).
//
// SAS_MISMATCH_WARNING — the full danger sentence shown whenever the human
// declares a mismatch. This must always travel WITH the flagged state; it is
// never reduced to an unexplained chip.
export const SAS_MISMATCH_WARNING =
  "This connection couldn’t be verified — someone may be intercepting it.";

// SAS_UNAVAILABLE_MESSAGE — TERMINAL failure copy. Calm and non-alarming, but
// explicitly NON-positive: it must not read as a verified/secure assurance.
export const SAS_UNAVAILABLE_MESSAGE =
  "Couldn’t establish a safety phrase. You can still chat, but this call isn’t verified.";

// SAS_WHY_COMPARE — the one plain-language "why" line, shown on first
// appearance of the unverified state so people understand the point of
// comparing. Count-agnostic ("the same phrase").
export const SAS_WHY_COMPARE =
  "If both screens show the same phrase, no one is listening in.";

// SAS_COMPARE_PROMPT — the call to action in the unverified state. Count-
// agnostic ("the same phrase") so it survives the 4→5 token bump.
export const SAS_COMPARE_PROMPT =
  "Compare with the stranger — do both screens show the same phrase?";

// The tokens rendered in mono (count is variable). The emoji is decorative
// (aria-hidden); the word carries the meaning for a screen reader, so the whole
// list is exposed as "word, word, …" via an aria-label generated from the
// actual phrase array — never a hardcoded count.
export function PhraseTokens({
  phrase,
  className = "",
}: {
  phrase: SasPhrase;
  className?: string;
}) {
  return (
    <ul
      className={`flex flex-wrap items-center gap-1.5 ${className}`}
      aria-label={`Safety phrase: ${phrase.map((t) => t.word).join(", ")}`}
    >
      {phrase.map((t, i) => (
        <li
          key={`${t.word}-${i}`}
          className="hairline flex items-center gap-1.5 rounded-md border bg-ink-900/60 px-2 py-1 font-mono text-[13px] leading-none text-haze-100"
        >
          <span aria-hidden className="text-[15px] leading-none">
            {t.emoji}
          </span>
          <span>{t.word}</span>
        </li>
      ))}
    </ul>
  );
}

// Status glyphs — paired with a text label everywhere so state is never
// conveyed by colour alone (Story 5).
export function ShieldIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3l7 2.5v5.2c0 4.4-3 7.5-7 9-4-1.5-7-4.6-7-9V5.5L12 3Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CheckIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3l7 2.5v5.2c0 4.4-3 7.5-7 9-4-1.5-7-4.6-7-9V5.5L12 3Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M9 12l2 2 4-4.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function WarningIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3.5l9 16H3l9-16Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M12 10v4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <circle cx="12" cy="16.7" r="0.95" fill="currentColor" />
    </svg>
  );
}

// Terminal "unavailable" glyph — a shield with a slash through it. Distinct
// from both the verified check (positive) and the warning triangle (alarm):
// this reads as "no phrase / not established", calm but plainly not-verified.
export function ShieldOffIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3l7 2.5v5.2c0 4.4-3 7.5-7 9-4-1.5-7-4.6-7-9V5.5L12 3Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M5 4l14 16"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

import { z } from 'zod'

/** Deepgram's code-switching mode: the EA hears any language and answers in the last one used. */
export const EA_LANGUAGE_MULTI = 'multi'

/**
 * The languages the EA can listen and speak in: those both its speech to text (Deepgram Nova-3)
 * and its voice (ElevenLabs Flash v2.5) cover. `ea/src/seti_ea/language.py` mirrors the list.
 */
export const EA_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: EA_LANGUAGE_MULTI, name: 'Multilingual' },
  { code: 'ar', name: 'Arabic' },
  { code: 'bg', name: 'Bulgarian' },
  { code: 'zh', name: 'Chinese' },
  { code: 'hr', name: 'Croatian' },
  { code: 'cs', name: 'Czech' },
  { code: 'da', name: 'Danish' },
  { code: 'nl', name: 'Dutch' },
  { code: 'fil', name: 'Filipino' },
  { code: 'fi', name: 'Finnish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'el', name: 'Greek' },
  { code: 'hi', name: 'Hindi' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'id', name: 'Indonesian' },
  { code: 'it', name: 'Italian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'ms', name: 'Malay' },
  { code: 'no', name: 'Norwegian' },
  { code: 'pl', name: 'Polish' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ro', name: 'Romanian' },
  { code: 'ru', name: 'Russian' },
  { code: 'sk', name: 'Slovak' },
  { code: 'es', name: 'Spanish' },
  { code: 'sv', name: 'Swedish' },
  { code: 'ta', name: 'Tamil' },
  { code: 'tr', name: 'Turkish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'vi', name: 'Vietnamese' },
] as const

export type EaLanguage = (typeof EA_LANGUAGES)[number]['code']

export const EA_LANGUAGE_DEFAULT: EaLanguage = 'en'

export const eaLanguage = z.enum(EA_LANGUAGES.map((language) => language.code))

/** The display name of a language code; the code itself when the list no longer has it. */
export const eaLanguageName = (code: string): string =>
  EA_LANGUAGES.find((language) => language.code === code)?.name ?? code

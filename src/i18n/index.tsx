import { createContext, useContext } from 'react'
import { dictionaries, type Language, type Message } from './dictionaries'
import type { Diagnostic } from '../solver/diagnostics'
import type { LoadCase } from '../solver/types'

export const LanguageContext = createContext<Language>('en')

export function formatSignificant(language: Language, value: number | undefined, digits = 4) {
  if (value === undefined) return '—'
  const magnitude = Math.abs(value)
  return new Intl.NumberFormat(language, {
    maximumSignificantDigits: digits,
    notation: magnitude >= 1e6 || (magnitude > 0 && magnitude < 1e-3) ? 'scientific' : 'standard',
  }).format(value)
}

export function translateDiagnostic(language: Language, issue: Diagnostic): string {
  const dictionary = dictionaries[language]
  const { code, params } = issue
  const number = new Intl.NumberFormat(language)
  const percent = new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 4 })
  switch (code) {
    case 'volumeError':
      return dictionary[code].replace('{target}', percent.format(params.target))
        .replace('{min}', percent.format(params.min)).replace('{max}', percent.format(params.max))
    case 'detachedNodes': {
      const labels = params.nodes.map(({ kind, x, y }) =>
        `${dictionary[kind === 'load' ? 'detachedLoad' : 'detachedSupport']} (${number.format(x)}, ${number.format(y)})`)
      return dictionary[code].replace('{nodes}', new Intl.ListFormat(language).format(labels))
    }
    case 'nodalForceLimit':
    case 'netForceLimit':
      return dictionary[code].replace('{case}', number.format(params.case)).replace('{limit}', number.format(params.limit))
    case 'pcgFailure':
      return dictionary[code].replace('{case}', number.format(params.case))
        .replace('{residual}', formatSignificant(language, params.residual, 3))
    case 'stressOverflow':
      return dictionary[code].replace('{case}', number.format(params.case))
    case 'projectError':
      return params.field ? `${dictionary[code]} (${params.field})` : dictionary[code]
    default:
      return dictionary[code]
  }
}

export function useTranslation() {
  const language = useContext(LanguageContext)
  const dictionary = dictionaries[language]
  const t = (message: Message) => dictionary[message]
  const caseName = (load: LoadCase) => {
    if (load.presetName) return t(load.presetName)
    if (load.generatedNumber) return `${t('case')} ${load.generatedNumber}`
    return load.name
  }
  const number = (value?: number) => value === undefined ? '—' : new Intl.NumberFormat(language).format(value)
  const significant = (value?: number, digits?: number) => formatSignificant(language, value, digits)
  const fixed = (value: number | undefined, digits: number) => value === undefined ? '—' : new Intl.NumberFormat(language, {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(value)
  const diagnostic = (issue: Diagnostic) => translateDiagnostic(language, issue)
  return { t, language, caseName, diagnostic, number, significant, fixed }
}

import { createContext, useContext } from 'react'
import { dictionaries, type Language, type Message } from './dictionaries'
import type { LoadCase } from '../solver/types'

export const LanguageContext = createContext<Language>('en')

export function useTranslation() {
  const language = useContext(LanguageContext)
  const dictionary = dictionaries[language]
  const t = (message: Message) => dictionary[message]
  const caseName = (load: LoadCase) => {
    if (load.presetName) return t(load.presetName)
    if (load.generatedNumber) return `${t('case')} ${load.generatedNumber}`
    return load.name
  }
  const diagnostic = (message: string) => {
    if (message === 'Mirror symmetry conflicts with the passive masks.') return t('maskConflict')
    if (message === 'A passive solid has no path to the build plate.') return t('amConflict')
    if (message.startsWith('The target volume fraction is infeasible')) return t('volumeError')
    return language === 'en' ? message : t('workerError')
  }
  return { t, language, caseName, diagnostic }
}

import { useTranslation } from '../i18n'
import type { LoadCase } from '../solver/types'

const colors = ['#ffb676', '#80d7ff', '#d7acff', '#9df3a0', '#ff9cc0', '#f4e478']

export function caseColor(index: number) {
  return colors[index] ?? `hsl(${(index * 137.508) % 360} 78% ${index % 2 ? 65 : 76}%)`
}

export function LoadCases({ cases, active, onSelect, onAdd, onRemove, onRename }: {
  cases: readonly LoadCase[]
  active: LoadCase
  onSelect: (id: string) => void
  onAdd: () => void
  onRemove: () => void
  onRename: (name: string) => void
}) {
  const { t, caseName, language } = useTranslation()
  const name = caseName(active)
  return (
    <section aria-label={t('cases')}>
      <h3>{t('cases')}</h3>
      <div className="case-list" role="group" aria-label={t('activeCase')}>
        {cases.map((load, index) => (
          <button className="case-row" key={load.id} type="button" aria-pressed={active.id === load.id} onClick={() => onSelect(load.id)}>
            <i style={{ backgroundColor: caseColor(index) }} />
            <span>{caseName(load) || `${t('case')} ${index + 1}`}</span>
            <small>{load.forces.length}</small>
          </button>
        ))}
      </div>
      <label htmlFor="case-name">{t('caseName')}</label>
      <input id="case-name" className="field-input" key={`${language} ${active.id} ${name}`} defaultValue={name} maxLength={48}
        onBlur={event => {
          const value = event.target.value.trim() || name
          event.target.value = value
          if (value !== name) onRename(value)
        }}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
      <div className="action-row">
        <button className="tool-button" type="button" onClick={onAdd}>{t('addCase')}</button>
        <button className="tool-button" type="button" onClick={onRemove} disabled={cases.length === 1}>{t('remove')}</button>
      </div>
    </section>
  )
}

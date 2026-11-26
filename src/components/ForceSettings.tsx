import { useState } from 'react'
import { useTranslation } from '../i18n'
import { directionVector, isValidForce, MAX_NODAL_FORCE, type ForceVector } from '../solver/design'

const directions = [
  ['down', 'forceDown'], ['up', 'forceUp'], ['right', 'forceRight'], ['left', 'forceLeft'],
] as const

export function ForceSettings({ force, onChange }: { force: ForceVector; onChange: (force: ForceVector) => void }) {
  const { t, significant } = useTranslation()
  const [draft, setDraft] = useState<{ field: 'magnitude' | 'fx' | 'fy'; value: string; invalid: boolean }>()
  const magnitude = Math.hypot(force.fx, force.fy)

  function field(key: 'magnitude' | 'fx' | 'fy', value: number, label: string) {
    return <label className="compact-input">{label}
      <input className="field-input" type="number" step="any" min={key === 'magnitude' ? 0 : -MAX_NODAL_FORCE}
        max={MAX_NODAL_FORCE} value={draft?.field === key ? draft.value : Number(value.toPrecision(12))}
        aria-invalid={draft?.field === key && draft.invalid ? true : undefined}
        onBlur={() => setDraft(undefined)}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
        onChange={event => {
          const { value: text, valueAsNumber: number } = event.currentTarget
          const next = key !== 'magnitude' ? { ...force, [key]: number } : magnitude === 0
            ? directionVector('down', number) : { fx: (force.fx / magnitude) * number, fy: (force.fy / magnitude) * number }
          const valid = (key !== 'magnitude' || number >= 0) && isValidForce(next.fx, next.fy)
          setDraft({ field: key, value: text, invalid: !valid })
          if (valid) onChange(next)
        }} />
    </label>
  }

  return <div className="force-settings">
    {field('magnitude', magnitude, `${t('forceMagnitude')} (${t('N')})`)}
    {field('fx', force.fx, `Fx (${t('N')})`)}
    {field('fy', force.fy, `Fy (${t('N')})`)}
    <div className="action-row" role="group" aria-label={t('forceDirections')}>
      {directions.map(([direction, label]) => {
        const next = directionVector(direction, magnitude)
        return <button key={direction} className="tool-button" type="button"
          aria-pressed={magnitude > 0 && next.fx === force.fx && next.fy === force.fy}
          onClick={() => onChange(next)}>{t(label)}</button>
      })}
    </div>
    {draft?.invalid && <p role="alert">{t('forceLimit').replace('{limit}', significant(MAX_NODAL_FORCE))}</p>}
  </div>
}

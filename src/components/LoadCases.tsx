import { useState } from 'react'
import { useTranslation } from '../i18n'
import { clearLoads, isValidForce, MAX_NODAL_FORCE, setForce, type ForceVector } from '../solver/design'
import type { Grid, LoadCase, NodalForce } from '../solver/types'

const colors = ['#ffb676', '#80d7ff', '#d7acff', '#9df3a0', '#ff9cc0', '#f4e478']

export function caseColor(index: number) {
  return colors[index] ?? `hsl(${(index * 137.508) % 360} 78% ${index % 2 ? 65 : 76}%)`
}

function LoadRow({ force, grid, editing, onEdit, onSave, onDelete }: {
  force: NodalForce
  grid: Grid
  editing: boolean
  onEdit: () => void
  onSave: (force: ForceVector) => void
  onDelete: () => void
}) {
  const { t, significant } = useTranslation()
  const [invalid, setInvalid] = useState(false)
  const { node, fx, fy } = force
  const x = node % (grid.nelx + 1), y = Math.floor(node / (grid.nelx + 1))
  const coordinates = `(${x}, ${y})`
  return <li className="nodal-load">
    <div className="nodal-load-row">
      <button className="nodal-load-edit" type="button" aria-label={t('editForce').replace('{node}', coordinates)}
        aria-expanded={editing} onClick={onEdit}>
        <strong>{coordinates}</strong>
        <span>Fx {significant(fx)} · Fy {significant(fy)}</span>
      </button>
      <button className="tool-button nodal-load-delete" type="button"
        aria-label={t('deleteForce').replace('{node}', coordinates)} onClick={onDelete}>×</button>
    </div>
    {editing && <form className="nodal-load-form" onChange={() => setInvalid(false)} onSubmit={event => {
      event.preventDefault()
      const values = new FormData(event.currentTarget)
      const next = { fx: Number(values.get('fx')), fy: Number(values.get('fy')) }
      if (isValidForce(next.fx, next.fy)) onSave(next)
      else setInvalid(true)
    }}>
      <label>Fx ({t('N')}) <input className="field-input" name="fx" type="number" step="any" defaultValue={fx} required /></label>
      <label>Fy ({t('N')}) <input className="field-input" name="fy" type="number" step="any" defaultValue={fy} required /></label>
      <button className="tool-button" type="submit">{t('applyForce')}</button>
      {invalid && <p role="alert">{t('forceLimit').replace('{limit}', significant(MAX_NODAL_FORCE))}</p>}
    </form>}
  </li>
}

export function LoadCases({ grid, cases, active, onSelect, onAdd, onRemove, onRename, onChange }: {
  grid: Grid
  cases: readonly LoadCase[]
  active: LoadCase
  onSelect: (id: string) => void
  onAdd: () => void
  onRemove: () => void
  onRename: (name: string) => void
  onChange: (loadCase: LoadCase) => void
}) {
  const { t, caseName, language } = useTranslation()
  const [editing, setEditing] = useState<{ caseId: string; node: number }>()
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
      <div className="parameter-label">
        <h3>{t('nodalLoads')} ({t('N')})</h3>
        <button className="tool-button clear-button" type="button" disabled={!active.forces.length} onClick={() => {
          setEditing(undefined)
          onChange(clearLoads(active))
        }}>{t('clearLoads')}</button>
      </div>
      {active.forces.length === 0 ? <p className="empty-loads">{t('noLoads')}</p> :
        <ul className="nodal-load-list" aria-label={t('nodalLoads')}>
          {active.forces.map(force => {
            const isEditing = editing?.caseId === active.id && editing.node === force.node
            return <LoadRow key={`${active.id}/${force.node}/${force.fx}/${force.fy}`} force={force} grid={grid} editing={isEditing}
              onEdit={() => setEditing(isEditing ? undefined : { caseId: active.id, node: force.node })}
              onSave={value => {
                setEditing(undefined)
                onChange(setForce(active, force.node, value))
              }} onDelete={() => {
                if (isEditing) setEditing(undefined)
                onChange(setForce(active, force.node, null))
              }} />
          })}
        </ul>}
    </section>
  )
}
